/**
 * MiniMax 视频生成 Adapter
 *
 * 同时支持 MiniMax 的两代视频接口，并按**模型族**路由（同一适配器内部分流）：
 *
 * 1) v2 接口（H3 全模态系列）
 *    提交: POST /v2/video_generation            → { task_id }
 *    轮询: GET  /v2/query/video_generation/{id} → { task: { status, content.url, error } }
 *    content[] 多模态结构:
 *      - text        提示词（必填，≤7000 字符）
 *      - image_url   role: first_frame / last_frame / reference_image（参考图 ≤9）
 *      - video_url   role: reference_video（≤3）
 *      - audio_url   参考音频（≤3），混合总数 ≤12
 *    模型能力差异（官方口径）:
 *      - MiniMax-H3            768P / 2K，4–15s
 *      - MiniMax-H3-Highspeed  仅 768P（不支持 2K），4–15s
 *      - MiniMax-H3-Lite       480P / 768P，4–15s
 *      - MiniMax-H3-Max        480P / 768P，5–15s
 *      - MiniMax-H3-Max-Turbo  480P / 768P，不支持参考生与视频输入
 *    注意:
 *      - 文生视频 ratio 必填且不能为 adaptive；有首帧图（图生视频）时恒为 adaptive，省略 ratio
 *      - H3 原生音画同步生成，官方文档无独立 generate_audio 开关，该字段忽略
 *
 * 2) v1 接口（Hailuo 经典系列）
 *    提交: POST /v1/video_generation              → { task_id, base_resp }
 *    轮询: GET  /v1/query/video_generation?task_id= → { status, file_id, video_width, video_height, base_resp }
 *    取件: GET  /v1/files/retrieve?file_id=&task_id= → { file: { download_url } }
 *    status 取值: Queueing / Preparing / Processing / Success / Fail
 *    模型能力差异（官方口径）:
 *      - MiniMax-Hailuo-2.3       文生+图生，768P/1080P，6s（1080P）/ 6s、10s（768P）
 *      - MiniMax-Hailuo-2.3-Fast  仅图生（首帧必填），768P/1080P，同上
 *      - MiniMax-Hailuo-02        文生+图生+首尾帧插值，512P/768P/1080P，6s、10s（512P/768P）
 *      - T2V/I2V/S2V/Video-01     720P，6s
 *    注意:
 *      - 首尾帧插值（last_frame_image）**只有 MiniMax-Hailuo-02 支持**，其他模型传了会被上游拒绝
 *      - I2V-01 系列与 Hailuo-2.3-Fast 必须提供 first_frame_image
 *
 * 业务错误全部藏在 base_resp 里，HTTP 200 也可能是失败，必须显式校验。
 */
import type {
  VideoProviderAdapter,
  ProviderRequest,
  ProviderPollContext,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'
import { joinProviderUrl } from './url'
import {
  assertMiniMaxOk,
  getClassicVideoProfile,
  getH3Profile,
  isClassicVideoModel,
  isH3Model,
  parseBaseResp,
  type MiniMaxVideoProfile,
} from './minimax-common'
import { ProviderError } from './errors'
import { compileH3Prompt } from './minimax-h3-prompt.js'

/** H3 默认模型 */
const DEFAULT_H3_MODEL = 'MiniMax-H3'
/** v1 默认模型 */
const DEFAULT_CLASSIC_MODEL = 'MiniMax-Hailuo-2.3'

/** 多模态参考素材上限：图片 9、视频 3、音频 3，混合总数 12 */
const REF_LIMITS = { images: 9, videos: 3, audios: 3, total: 12 } as const

const PROMPT_MAX_CHARS = 7000
/** v1 接口提示词上限 */
const CLASSIC_PROMPT_MAX_CHARS = 2000

/** MiniMax 支持的宽高比 */
const VALID_RATIOS = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'])

/** v1 接口支持的分辨率（老一代模型） */
const CLASSIC_RESOLUTIONS = new Set(['720P', '768P', '1080P'])

/**
 * 项目侧分辨率 → MiniMax 官方档位的候选链。
 * 项目只存 480p / 720p 两档，这里按「就近可用」原则映射到厂商实际支持的档位。
 */
const RESOLUTION_CANDIDATES: Record<string, string[]> = {
  '480p': ['480P', '512P', '768P', '720P', '1080P'],
  '512p': ['512P', '480P', '768P', '720P', '1080P'],
  '720p': ['768P', '720P', '1080P', '512P', '480P'],
  '768p': ['768P', '1080P', '720P', '512P', '480P'],
  '1080p': ['1080P', '2K', '768P', '720P', '512P', '480P'],
  '2k': ['2K', '1080P', '768P', '720P', '512P', '480P'],
}

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string' && u.trim()) : []
  } catch {
    return []
  }
}

function boolValue(v: unknown, fallback = false): boolean {
  if (v === true || v === 1) return true
  if (v === false || v === 0) return false
  return fallback
}

export class MiniMaxVideoAdapter implements VideoProviderAdapter {
  provider = 'minimax'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const model = (record.model || config.model || '').trim()

    if (isH3Model(model)) return this.buildH3Request(config, record, model)
    if (isClassicVideoModel(model)) return this.buildClassicRequest(config, record, model)

    throw new ProviderError({
      stage: 'config',
      message: model
        ? `不支持的 MiniMax 视频模型：${model}`
        : '未指定 MiniMax 视频模型',
      hint: '可选模型：MiniMax-H3 / MiniMax-H3-Highspeed / MiniMax-H3-Lite / MiniMax-H3-Max（v2 接口）；MiniMax-Hailuo-2.3 / MiniMax-Hailuo-2.3-Fast / MiniMax-Hailuo-02 / T2V-01-Director / I2V-01 / S2V-01（v1 接口）',
    })
  }

  // ─── v2 接口（H3 系列） ────────────────────────────────────────

  private buildH3Request(config: AIConfig, record: VideoGenerationRecord, model: string): ProviderRequest {
    const profile = getH3Profile(model)!
    let prompt = (record.prompt || '').trim()
    const refImages = parseUrlArray(record.referenceImageUrls)
    const refVideos = parseUrlArray(record.referenceVideoUrls)
    const refAudios = parseUrlArray(record.referenceAudioUrls)
    const firstFrame = (record.firstFrameUrl || record.imageUrl || '').trim()
    const lastFrame = (record.lastFrameUrl || '').trim()

    if (!prompt) {
      throw new ProviderError({
        stage: 'config',
        message: 'MiniMax H3 要求必须提供提示词（text content）',
        hint: '请填写视频提示词后再提交',
      })
    }
    if (prompt.length > PROMPT_MAX_CHARS) {
      throw new ProviderError({
        stage: 'config',
        message: `提示词超长：MiniMax H3 上限 ${PROMPT_MAX_CHARS} 字符，当前 ${prompt.length}`,
        hint: '请精简提示词后重试',
      })
    }

    const resolution = pickResolution(record.resolution, profile)
    const duration = pickDuration(record.duration, profile, resolution)

    // 使用 MiniMax H3 官方提示词规范编译器自动转译（分镜头、对白口型同步、参考主体映射、首尾帧对齐）
    prompt = compileH3Prompt({
      prompt,
      duration,
      hasFirstFrame: Boolean(firstFrame),
      hasLastFrame: Boolean(lastFrame),
      referenceImageCount: refImages.length,
    })

    const totalRefs = refImages.length + refVideos.length + refAudios.length + (firstFrame ? 1 : 0) + (lastFrame ? 1 : 0)
    if (refImages.length > REF_LIMITS.images || refVideos.length > REF_LIMITS.videos || refAudios.length > REF_LIMITS.audios || totalRefs > REF_LIMITS.total) {
      throw new ProviderError({
        stage: 'config',
        message: `参考素材超限：图片≤${REF_LIMITS.images}、视频≤${REF_LIMITS.videos}、音频≤${REF_LIMITS.audios}、总数≤${REF_LIMITS.total}`,
        hint: '请删减参考素材数量后重试',
      })
    }

    // 参考生能力按模型档案校验（H3-Max-Turbo 明确不支持参考生与视频输入）
    if (!profile.supportsReference && (refImages.length || refVideos.length || refAudios.length)) {
      throw new ProviderError({
        stage: 'config',
        message: `${profile.model} 不支持多模态参考素材`,
        hint: profile.note || '请改用 MiniMax-H3 或 H3-Lite 等支持参考生的模型',
      })
    }
    if (lastFrame && !profile.supportsLastFrame) {
      throw new ProviderError({
        stage: 'config',
        message: `${profile.model} 不支持尾帧（首尾帧插值）`,
        hint: '请改用支持首尾帧的模型，或只提供首帧图',
      })
    }

    const content: any[] = [{ type: 'text', text: prompt }]
    if (firstFrame) content.push({ type: 'image_url', image_url: { url: firstFrame }, role: 'first_frame' })
    if (lastFrame) content.push({ type: 'image_url', image_url: { url: lastFrame }, role: 'last_frame' })
    for (const url of refImages) {
      content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
    }
    for (const url of refVideos) {
      content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
    }
    for (const url of refAudios) {
      content.push({ type: 'audio_url', audio_url: { url } })
    }

    const body: any = {
      model,
      content,
      duration,
      resolution,
    }

    // 图生视频（有首帧）ratio 恒为 adaptive，省略；文生视频 ratio 必填
    if (!firstFrame) {
      const ratio = (record.aspectRatio || '').trim()
      body.ratio = VALID_RATIOS.has(ratio) ? ratio : '16:9'
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v2', '/video_generation'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  // ─── v1 接口（Hailuo 经典系列） ────────────────────────────────

  private buildClassicRequest(config: AIConfig, record: VideoGenerationRecord, model: string): ProviderRequest {
    const profile = getClassicVideoProfile(model)
    if (!profile) {
      throw new ProviderError({
        stage: 'config',
        message: `未识别的 MiniMax v1 视频模型：${model}`,
        hint: '可选模型：MiniMax-Hailuo-2.3 / MiniMax-Hailuo-2.3-Fast / MiniMax-Hailuo-02 / T2V-01-Director / I2V-01 / S2V-01',
      })
    }
    const prompt = (record.prompt || '').trim()
    if (!prompt) {
      throw new ProviderError({
        stage: 'config',
        message: 'MiniMax 视频生成需要提示词',
        hint: '请填写视频提示词后再提交',
      })
    }
    if (prompt.length > CLASSIC_PROMPT_MAX_CHARS) {
      throw new ProviderError({
        stage: 'config',
        message: `提示词超长：MiniMax v1 视频接口上限 ${CLASSIC_PROMPT_MAX_CHARS} 字符，当前 ${prompt.length}`,
        hint: '请精简提示词后重试',
      })
    }

    const firstFrame = (record.firstFrameUrl || record.imageUrl || '').trim()
    const lastFrame = (record.lastFrameUrl || '').trim()
    const refImages = parseUrlArray(record.referenceImageUrls)

    // 首帧必填的模型（I2V-01 系列、Hailuo-2.3-Fast）
    if (profile.requiresFirstFrame && !firstFrame) {
      throw new ProviderError({
        stage: 'config',
        message: `${profile.model} 仅支持图生视频，必须提供首帧图`,
        hint: profile.note || '请为该分镜绑定首帧图，或改用支持文生视频的模型（如 MiniMax-Hailuo-2.3 / MiniMax-Hailuo-02）',
      })
    }
    // 首尾帧插值只有 MiniMax-Hailuo-02 支持
    if (lastFrame && !profile.supportsLastFrame) {
      throw new ProviderError({
        stage: 'config',
        message: `${profile.model} 不支持尾帧（首尾帧插值）`,
        hint: '首尾帧插值仅 MiniMax-Hailuo-02 支持；请改用该模型，或只提供首帧图',
      })
    }

    const resolution = pickResolution(record.resolution, profile)
    const duration = pickDuration(record.duration, profile, resolution)

    const body: any = {
      model,
      prompt,
      duration,
      resolution,
    }
    if (profile.supportsPromptOptimizer) {
      body.prompt_optimizer = boolValue(record.promptExtend, true)
    }
    // AIGC 水印开关（v1 契约字段，默认不带=不加水印）
    body.aigc_watermark = boolValue(record.watermark, false)

    if (firstFrame) body.first_frame_image = firstFrame
    if (lastFrame) body.last_frame_image = lastFrame

    // S2V-01 走 subject_reference（只支持公网 URL）
    if (profile.supportsSubjectReference) {
      const face = refImages[0]
      if (!face) {
        throw new ProviderError({
          stage: 'config',
          message: 'S2V-01 需要一张角色参考图',
          hint: '请在分镜中绑定角色参考图，或改用 I2V-01 / T2V-01 系列',
        })
      }
      if (face.startsWith('data:')) {
        throw new ProviderError({
          stage: 'config',
          message: 'S2V-01 的角色参考图需要公网可访问的图片 URL，当前是内联 data URL',
          hint: '在 backend/.env 配置 PUBLIC_BASE_URL（如 https://your-domain.com）后重试',
        })
      }
      body.subject_reference = [{ type: 'character', image: [face] }]
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/video_generation'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  // ─── 响应解析 ──────────────────────────────────────────────────

  parseGenerateResponse(result: any): VideoGenResponse {
    // v2 同步返回（极少数情况下直接带 content.url）
    const task = result?.task && typeof result.task === 'object' ? result.task : result
    const state = task?.status
    const videoUrl = task?.content?.url || result?.content?.url || result?.video_url
    const rawTaskId = result?.task_id ?? task?.id
    if (videoUrl && (!state || state === 'succeeded' || state === 'Success')) {
      return {
        isAsync: false,
        videoUrl,
        taskId: rawTaskId == null ? undefined : String(rawTaskId),
        duration: task?.duration ?? result?.duration,
      }
    }

    // v1 / v2 都是异步：提交成功时 base_resp.status_code 必须为 0
    assertMiniMaxOk(result, { stage: 'response' })

    const taskId = rawTaskId
    if (taskId != null) return { isAsync: true, taskId: String(taskId) }

    const { statusCode, statusMsg } = parseBaseResp(result)
    throw new ProviderError({
      stage: 'response',
      message: statusMsg?.trim() || 'MiniMax 未返回 task_id',
      providerCode: statusCode,
      providerMessage: statusMsg,
      responseBody: result,
      hint: '请确认模型名与账号权限（1039 表示模型未开通）',
    })
  }

  buildPollRequest(config: AIConfig, taskId: string, context?: ProviderPollContext): ProviderRequest {
    const model = context?.model || config.model || ''
    if (isH3Model(model)) {
      return {
        url: joinProviderUrl(config.baseUrl, '/v2', `/query/video_generation/${taskId}`),
        method: 'GET',
        headers: { 'Authorization': `Bearer ${config.apiKey}` },
        body: undefined,
      }
    }
    return {
      url: joinProviderUrl(config.baseUrl, '/v1', `/query/video_generation?task_id=${encodeURIComponent(taskId)}`),
      method: 'GET',
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    assertMiniMaxOk(result, { stage: 'poll' })

    // v2: { task: { status: 'succeeded' | 'failed' | 'processing', content: { url }, error } }
    const task = result?.task && typeof result.task === 'object' ? result.task : result
    const status = String(task?.status ?? result?.status ?? '')

    if (status === 'succeeded' || status === 'Success') {
      return {
        status: 'completed',
        videoUrl: task?.content?.url || result?.content?.url || task?.video_url,
        duration: task?.duration ?? result?.duration,
        fileId: result?.file_id,
        width: pickNumber(task?.video_width ?? result?.video_width),
        height: pickNumber(task?.video_height ?? result?.video_height),
      }
    }

    if (status === 'failed' || status === 'Fail' || status === 'cancelled') {
      const err = task?.error ?? result?.error
      const msg = typeof err === 'string' ? err : (err?.message || JSON.stringify(err) || 'Video generation failed')
      const code = err && typeof err === 'object' && err.code ? `[${err.code}] ` : ''
      return { status: 'failed', error: `${code}${msg}` }
    }

    // v1 状态：Queueing / Preparing / Processing
    return {
      status: 'processing',
      stage: task?.delivery?.status === 'transferring' ? 'transferring' : undefined,
    }
  }

  extractVideoUrl(result: any): string | null {
    const task = result?.task && typeof result.task === 'object' ? result.task : result
    return task?.content?.url || task?.video_url || result?.video_url || null
  }

  /** v1 视频成功后只有 file_id，需再调一次 /v1/files/retrieve 换下载地址 */
  async resolveVideoUrl(config: AIConfig, poll: VideoPollResponse, raw: any): Promise<string | null> {
    if (poll.videoUrl) return poll.videoUrl
    const fileId = poll.fileId || raw?.file_id
    if (!fileId) return null

    // 官方取件接口同时接受 file_id 与 task_id，带上 task_id 兼容性更好
    const taskId = raw?.task_id ? `&task_id=${encodeURIComponent(String(raw.task_id))}` : ''
    const url = joinProviderUrl(config.baseUrl, '/v1', `/files/retrieve?file_id=${encodeURIComponent(String(fileId))}${taskId}`)
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(60_000),
    })
    const text = await resp.text()
    if (!resp.ok) {
      throw new ProviderError({
        stage: 'download',
        message: `MiniMax 取件失败 HTTP ${resp.status}`,
        httpStatus: resp.status,
        requestUrl: url,
        responseBody: text.slice(0, 2000),
        hint: '下载地址为临时链接，请尽快重试；如持续失败请核对 file_id 是否过期',
      })
    }
    const data = JSON.parse(text)
    assertMiniMaxOk(data, { stage: 'download', requestUrl: url })
    const downloadUrl = data?.file?.download_url
    if (!downloadUrl) {
      throw new ProviderError({
        stage: 'download',
        message: 'MiniMax /v1/files/retrieve 未返回 download_url',
        requestUrl: url,
        responseBody: data,
        hint: '请确认账号权限与 file_id 有效性',
      })
    }
    return downloadUrl
  }

  /**
   * 交付恢复：向网关请求重新拉取成片。
   *
   * 只有 v2（H3）链路有独立的恢复入口 —— 火宝网关在
   * `POST {base}/v2/query/video_generation/{task_id}/recover` 上实现了
   * 「按已有任务号重新取回结果」，v1 系列没有对应能力。
   */
  buildRecoveryRequest(config: AIConfig, taskId: string, context?: ProviderPollContext): ProviderRequest {
    const model = context?.model || config.model || ''
    if (!isH3Model(model)) {
      throw new ProviderError({
        stage: 'config',
        message: '当前 MiniMax 视频模型不支持交付恢复',
        hint: 'v1 系列模型请等待上游任务完成后重新生成',
      })
    }
    return {
      url: joinProviderUrl(config.baseUrl, '/v2', `/query/video_generation/${taskId}/recover`),
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      body: undefined,
    }
  }
}

// ─── 参数归一化（按模型档案） ──────────────────────────────────────

function pickNumber(v: any): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * 选择官方支持的分辨率。
 * 项目侧只存 480p / 720p，这里按候选链映射到该模型实际支持的档位。
 */
export function pickResolution(requested: string | null | undefined, profile: MiniMaxVideoProfile): string {
  const key = String(requested || '').trim().toLowerCase()
  const candidates = RESOLUTION_CANDIDATES[key] ?? []
  for (const c of candidates) {
    if (profile.resolutions.includes(c)) return c
  }
  return profile.defaultResolution
}

/**
 * 选择官方支持的时长。
 * - H3 是连续区间（4–15s 或 5–15s），按区间钳制
 * - v1 是离散档位（6s / 10s），且 10s 只在部分分辨率下可用
 */
export function pickDuration(
  requested: number | null | undefined,
  profile: MiniMaxVideoProfile,
  resolution: string,
): number {
  const parsed = Math.round(Number(requested || profile.defaultDuration))
  const safe = Number.isFinite(parsed) ? parsed : profile.defaultDuration

  // v1：离散档位
  if (profile.durations.length <= 2 && profile.durations.includes(10)) {
    let duration = safe <= 6 ? 6 : 10
    // 10s 只在 768P / 512P 下可用
    const maxAtRes = maxDurationForResolution(profile, resolution)
    if (duration > maxAtRes) duration = maxAtRes
    return duration
  }

  // v2：连续区间
  if (safe <= profile.minDuration) return profile.minDuration
  if (safe >= profile.maxDuration) return profile.maxDuration
  return safe
}

/** 某个分辨率下的最大时长 */
export function maxDurationForResolution(profile: MiniMaxVideoProfile, resolution: string): number {
  if (profile.api === 'v1') {
    if (resolution === '1080P') return 6
    if (resolution === '768P' || resolution === '512P') return 10
    return profile.maxDuration
  }
  return profile.maxDuration
}

export { DEFAULT_H3_MODEL, DEFAULT_CLASSIC_MODEL, CLASSIC_RESOLUTIONS }
