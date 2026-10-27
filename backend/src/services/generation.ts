/**
 * 统一生成任务服务 — 图片/视频生成共用 sys_task 表与同一条生命周期：
 * 创建(processing) → 适配器构建请求 → 同步完成或异步轮询 → 下载落盘 → 回写业务表
 */
import { db, getInsertId, schema } from '../db/index.js'
import { and, desc, eq, gt } from 'drizzle-orm'
import fs from 'node:fs'
import { getAbsolutePath } from '../utils/storage.js'
import { downloadVideo, safeTaskError } from './video-download.js'
import { getActiveConfig, getConfigById } from './ai.js'
import { now } from '../utils/response.js'
import { downloadFile, fetchImageAsCompressedDataUrl, generateImageThumb, readImageAsCompressedDataUrl, readImageAsDataUrl, saveBase64Image } from '../utils/storage.js'
import { extractVideoPoster } from '../utils/video-poster.js'
import { getImageAdapter, getVideoAdapter } from './adapters/registry'
import type { AIConfig, ImageProviderAdapter, VideoProviderAdapter } from './adapters/types'
import { ProviderError, toProviderErrorDetail, type ProviderErrorDetail, previewBody } from './adapters/errors'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn, redactUrl } from '../utils/task-logger.js'

type TaskType = 'image' | 'video'

const activeTasks = new Set<number>()
const videoSubmissions = new Set<number>()
function runBackground(id: number, job: () => Promise<void>) {
  if (activeTasks.has(id)) return
  activeTasks.add(id)
  void job().catch(error => failTask(id, safeTaskError(error))).finally(() => activeTasks.delete(id))
}

const taskLabel = (type: TaskType) => (type === 'image' ? 'ImageTask' : 'VideoTask')

// 轮询节奏：图片 5s×120（上限 10 分钟）；视频 10s×300
const POLL_PROFILES: Record<TaskType, { attempts: number; intervalMs: number; maxDurationMs: number | null }> = {
  image: { attempts: 120, intervalMs: 5000, maxDurationMs: 600_000 },
  video: { attempts: 300, intervalMs: 10_000, maxDurationMs: null },
}

interface GenerateImageParams {
  storyboardId?: number
  dramaId?: number
  sceneId?: number
  characterId?: number
  propId?: number
  prompt: string
  model?: string
  size?: string
  referenceImages?: string[]
  frameType?: string
  /** 画风（MiniMax image-01-live 的 style.style_type） */
  style?: string
  configId?: number
}

interface GenerateVideoParams {
  storyboardId?: number
  dramaId?: number
  prompt: string
  model?: string
  referenceMode?: string
  imageUrl?: string
  firstFrameUrl?: string
  lastFrameUrl?: string
  referenceImageUrls?: string[]
  referenceVideoUrls?: string[]
  referenceAudioUrls?: string[]
  referenceFileUrl?: string
  referenceLinkUrl?: string
  generateAudio?: boolean
  duration?: number
  aspectRatio?: string
  resolution?: string
  seed?: number
  promptExtend?: boolean
  watermark?: boolean
  configId?: number
  forceNew?: boolean
}

export async function generateImage(params: GenerateImageParams): Promise<number> {
  // 指定配置（集锁定）可能已停用/删除/厂商收敛，失效时回退到当前启用配置，避免生成被旧引用卡死
  const config = params.configId
    ? (await getConfigById(params.configId)) ?? await getActiveConfig('image')
    : await getActiveConfig('image')
  if (!config) throw new Error('未配置图片模型，请先到「设置」页添加并启用 AI 服务')

  const id = await createTask('image', config, {
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    propId: params.propId,
    prompt: params.prompt,
    model: params.model || config.model,
  }, {
    size: params.size || '1920x1080',
    frameType: params.frameType,
    referenceImages: params.referenceImages,
    style: params.style,
  })

  logTaskStart('ImageTask', 'enqueue', {
    id,
    provider: config.provider,
    storyboardId: params.storyboardId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    frameType: params.frameType,
    model: params.model || config.model,
  })
  logTaskPayload('ImageTask', 'enqueue params', {
    id,
    config: { provider: config.provider, model: config.model, baseUrl: config.baseUrl },
    params,
  })
  return id
}

export async function generateVideo(params: GenerateVideoParams): Promise<number> {
  const storyboardId = params.storyboardId
  if (storyboardId && videoSubmissions.has(storyboardId)) throw new Error('该分镜正在提交任务，请勿重复点击')
  if (storyboardId) videoSubmissions.add(storyboardId)
  try {
    if (storyboardId) {
      const [latest] = await db.select().from(schema.sysTask).where(and(eq(schema.sysTask.type, 'video'), eq(schema.sysTask.storyboardId, storyboardId)))
        .orderBy(desc(schema.sysTask.id)).limit(1)
      if (latest?.status === 'processing') throw new Error('该分镜已有运行中的任务，请等待结果')
      if (latest?.status === 'failed' && params.forceNew !== true) throw new Error('请先恢复原任务；重新生成需确认可能再次计费')
    }
    // 指定配置（集锁定）可能已停用/删除/厂商收敛，失效时回退到当前启用配置
    const config = params.configId
      ? (await getConfigById(params.configId)) ?? await getActiveConfig('video')
      : await getActiveConfig('video')
    if (!config) throw new Error('未配置视频模型，请先到「设置」页添加并启用 AI 服务')

    const id = await createTask('video', config, {
      storyboardId: params.storyboardId,
      dramaId: params.dramaId,
      prompt: params.prompt,
      model: params.model || config.model,
    }, {
      referenceMode: params.referenceMode || 'reference',
      imageUrl: params.imageUrl,
      firstFrameUrl: params.firstFrameUrl,
      lastFrameUrl: params.lastFrameUrl,
      referenceImageUrls: params.referenceImageUrls,
      referenceVideoUrls: params.referenceVideoUrls,
      referenceAudioUrls: params.referenceAudioUrls,
      referenceFileUrl: params.referenceFileUrl,
      referenceLinkUrl: params.referenceLinkUrl,
      generateAudio: params.generateAudio === false ? 0 : 1,
      duration: params.duration,
      aspectRatio: params.aspectRatio,
      // 统一存为项目内部格式，各适配器再转换为官方大小写与枚举。
      resolution: normalizeStoredVideoResolution(params.resolution),
      seed: params.seed,
      promptExtend: params.promptExtend,
      watermark: params.watermark,
    })

    logTaskStart('VideoTask', 'enqueue', {
      id,
      provider: config.provider,
      storyboardId: params.storyboardId,
      dramaId: params.dramaId,
      referenceMode: params.referenceMode || 'reference',
      duration: params.duration || 5,
    })
    logTaskPayload('VideoTask', 'enqueue params', {
      id,
      config: { provider: config.provider, model: config.model, baseUrl: config.baseUrl },
      params,
    })
    return id
  } finally {
    if (storyboardId) videoSubmissions.delete(storyboardId)
  }
}

async function createTask(
  type: TaskType,
  config: AIConfig,
  fields: {
    storyboardId?: number
    dramaId?: number
    sceneId?: number
    characterId?: number
    propId?: number
    prompt: string
    model?: string | null
  },
  params: Record<string, unknown>,
): Promise<number> {
  const ts = now()
  const res = await db.insert(schema.sysTask).values({
    type,
    ...fields,
    provider: config.provider,
    configId: config.id,
    configBaseUrl: config.baseUrl,
    stage: 'submitting',
    params: JSON.stringify(params),
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  })

  const id = getInsertId(res)
  runBackground(id, () => processTask(id, config))
  return id
}

function parseTaskParams(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {}
  try {
    return JSON.parse(raw) || {}
  } catch {
    return {}
  }
}

async function processTask(id: number, config: AIConfig) {
  // 请求上下文：失败时补进结构化详情（适配器抛错时未必带得上真实 URL）
  let requestContext: { url?: string; method?: string; body?: unknown } = {}
  try {
    const [record] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
    if (!record) return
    const type = record.type as TaskType
    const label = taskLabel(type)
    const params = parseTaskParams(record.params)
    logTaskProgress(label, 'build-request', {
      id,
      provider: config.provider,
      storyboardId: record.storyboardId,
      sceneId: record.sceneId,
      characterId: record.characterId,
    })

    let url: string, method: string, headers: Record<string, string>, body: unknown

    if (type === 'image') {
      const adapter = getImageAdapter(config.provider)
      // MiniMax 的 subject_reference 只接受公网可访问的图片 URL；
      // 其它厂商走 dataURL（multipart 上传 / inline_data 都支持）。
      const resolvedReferenceImages = config.provider === 'minimax'
        ? resolvePublicReferenceImages(params.referenceImages)
        : await normalizeReferenceImages(params.referenceImages)
      ;({ url, method, headers, body } = adapter.buildGenerateRequest(config, {
        id: record.id,
        model: record.model,
        prompt: record.prompt,
        size: params.size,
        frameType: params.frameType,
        referenceImages: resolvedReferenceImages.length ? JSON.stringify(resolvedReferenceImages) : null,
      }))
    } else {
      const adapter = getVideoAdapter(config.provider)
      const resolvedImageUrl = await normalizeVideoReferenceUrl(params.imageUrl)
      const resolvedFirstFrameUrl = await normalizeVideoReferenceUrl(params.firstFrameUrl)
      const resolvedLastFrameUrl = await normalizeVideoReferenceUrl(params.lastFrameUrl)
      // MiniMax S2V-01 的 subject_reference 只接受公网 URL；其余场景沿用 dataURL。
      const isMiniMaxS2V = config.provider === 'minimax' && /^s2v/i.test(record.model || config.model || '')
      const resolvedReferenceImageUrls = isMiniMaxS2V
        ? resolvePublicMediaUrls(params.referenceImageUrls, 'image')
        : await normalizeVideoReferenceUrls(params.referenceImageUrls)
      // 参考视频/音频文件较大，不适合 dataURL 内联，需解析为公网可访问 URL
      const resolvedReferenceVideoUrls = resolvePublicMediaUrls(params.referenceVideoUrls, 'video')
      const resolvedReferenceAudioUrls = resolvePublicMediaUrls(params.referenceAudioUrls, 'audio')
      const resolvedReferenceFileUrl = resolvePublicMediaUrl(params.referenceFileUrl, 'file')
      ;({ url, method, headers, body } = adapter.buildGenerateRequest(config, {
        id: record.id,
        model: record.model,
        prompt: record.prompt,
        referenceMode: params.referenceMode,
        imageUrl: resolvedImageUrl,
        firstFrameUrl: resolvedFirstFrameUrl,
        lastFrameUrl: resolvedLastFrameUrl,
        referenceImageUrls: resolvedReferenceImageUrls.length ? JSON.stringify(resolvedReferenceImageUrls) : null,
        referenceVideoUrls: resolvedReferenceVideoUrls.length ? JSON.stringify(resolvedReferenceVideoUrls) : null,
        referenceAudioUrls: resolvedReferenceAudioUrls.length ? JSON.stringify(resolvedReferenceAudioUrls) : null,
        referenceFileUrl: resolvedReferenceFileUrl,
        referenceLinkUrl: params.referenceLinkUrl,
        generateAudio: params.generateAudio,
        duration: params.duration,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        seed: params.seed,
        promptExtend: params.promptExtend,
        watermark: params.watermark,
      }))
    }

    logTaskProgress(label, 'request', {
      id,
      provider: config.provider,
      method,
      url: redactUrl(url),
      model: record.model,
    })

    requestContext = { url, method, body }

    const isMultipart = body instanceof FormData
    logTaskPayload(label, 'request payload', {
      id, method, url, headers,
      // multipart 表单（如 OpenAI /v1/images/edits）无法 JSON 化，记录字段摘要
      body: isMultipart ? `[multipart/form-data: ${[...(body as FormData).keys()].join(', ')}]` : body,
    })

    const resp = await fetch(url, {
      method,
      headers,
      body: isMultipart ? (body as FormData) : JSON.stringify(body),
      signal: AbortSignal.timeout(600_000),
    })

    // Firemux 在响应头提供内部任务编号；即使 JSON 响应体中断也能查询原任务。
    const gatewayTaskId = resp.headers.get('X-Firemux-Task-Id') || resp.headers.get('X-Huobao-Task-Id')
    if (type === 'video' && gatewayTaskId) {
      await markPolling(id, gatewayTaskId)
      record.taskId = gatewayTaskId
    }

    if (!resp.ok) {
      // 带上 HTTP 状态与响应原文，失败详情才有排查价值
      const text = await resp.text()
      throw new ProviderError({
        stage: resp.status === 401 || resp.status === 403 ? 'auth' : resp.status === 429 ? 'quota' : 'response',
        message: `HTTP ${resp.status} ${resp.statusText || ''}`.trim(),
        httpStatus: resp.status,
        requestUrl: url,
        requestBody: isMultipart ? `[multipart/form-data]` : body,
        responseBody: text.slice(0, 4000),
        hint: httpHint(resp.status, config.provider),
      })
    }
    const result = await resp.json() as any
    logTaskPayload(label, 'response payload', { id, provider: config.provider, result })

    if (type === 'image') {
      const adapter = getImageAdapter(config.provider)
      const { isAsync, taskId, imageUrl } = adapter.parseGenerateResponse(result)

      if (!isAsync && imageUrl) {
        logTaskProgress(label, 'sync-complete', { id, imageUrl })
        await handleImageComplete(record, imageUrl)
        return
      }

      if (!isAsync && !imageUrl) {
        // 同步模式但无 URL（Gemini 等返回 base64）
        const b64 = adapter.extractImageBase64(result)
        if (b64) {
          logTaskProgress(label, 'sync-base64-complete', { id, mimeType: b64.mimeType })
          await handleImageCompleteBase64(record, b64.data, b64.mimeType)
          return
        }
        throw new Error('No image URL or base64 data in response')
      }

      await markPolling(id, taskId)
      await pollTask(record, config, taskId!)
      return
    }

    const adapter = getVideoAdapter(config.provider)
    const { isAsync, taskId, videoUrl, duration } = adapter.parseGenerateResponse(result)
    if (taskId) {
      await markPolling(id, taskId)
      record.taskId = taskId
    }

    if (!isAsync && videoUrl) {
      logTaskProgress(label, 'sync-complete', { id, videoUrl })
      await handleVideoComplete(record, videoUrl, duration ?? params.duration)
      return
    }

    await markPolling(id, taskId)
    await pollTask(record, config, taskId!)
  } catch (err: any) {
    const [current] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
    const uncertain = current?.type === 'video' && !current.taskId && !current.resultUrl
      && (err instanceof TypeError || /timeout|abort|No task_id|API error 5/i.test(err.message))
    const detail = buildFailureDetail(err, {
      provider: config.provider,
      model: current?.model || null,
      stage: current?.stage || undefined,
      request: requestContext,
    })
    await failTask(id, safeTaskError(err), uncertain ? 'submission_unknown' : undefined, detail)
  }
}

/** HTTP 状态码 → 可操作建议 */
function httpHint(status: number, provider: string): string {
  if (status === 401 || status === 403) {
    return provider === 'minimax'
      ? 'MiniMax 鉴权失败：请确认 API Key 正确且该 Key 已开通对应模型权限'
      : '鉴权失败：请确认 API Key 正确、已生效且有该模型权限'
  }
  if (status === 404) return '端点 404：请检查 Base URL 与版本路径是否正确'
  if (status === 429) return '触发限流：请降低并发或稍后重试'
  if (status === 402) return '账户余额不足：请前往厂商控制台充值'
  if (status >= 500) return '厂商服务端异常（5xx），请稍后重试'
  return '请根据响应体核对请求参数与模型名'
}

/** 把异常转成结构化失败详情（含上游 task_id 等上下文） */
function buildFailureDetail(
  err: unknown,
  ctx: {
    provider?: string
    model?: string | null
    stage?: string | null
    request?: { url?: string; method?: string; body?: unknown }
  },
): ProviderErrorDetail {
  const detail = toProviderErrorDetail(err, ctx.stage === 'polling' ? 'poll' : 'response')
  return {
    ...detail,
    provider: ctx.provider,
    model: ctx.model,
    stage: detail.stage ?? 'unknown',
    // 适配器抛错时未必带得上真实请求地址，用本次实际发出的请求补齐
    requestUrl: detail.requestUrl ?? ctx.request?.url,
    requestBody: detail.requestBody ?? ctx.request?.body,
  } as ProviderErrorDetail
}

async function markPolling(id: number, taskId: string | undefined) {
  await db.update(schema.sysTask)
    .set({ taskId, stage: 'polling', status: 'processing', updatedAt: now() })
    .where(eq(schema.sysTask.id, id))
  logTaskProgress('SysTask', 'poll-start', { id, taskId })
}

async function failTask(id: number, message: string, code?: string, detail?: ProviderErrorDetail) {
  message = safeTaskError(message)
  logTaskError('SysTask', 'failed', { id, error: message, ...(detail?.stage ? { stage: detail.stage } : {}) })
  await db.update(schema.sysTask)
    .set({
      status: 'failed',
      errorMsg: safeTaskError(message),
      ...(code ? { errorCode: code } : {}),
      ...(detail ? { errorDetail: JSON.stringify(detail) } : {}),
      updatedAt: now(),
    })
    .where(eq(schema.sysTask.id, id))
}

type SysTaskRecord = typeof schema.sysTask.$inferSelect

async function pollTask(record: SysTaskRecord, config: AIConfig, taskId: string) {
  const type = record.type as TaskType
  const label = taskLabel(type)
  const profile = POLL_PROFILES[type]
  const adapter: ImageProviderAdapter | VideoProviderAdapter = type === 'image'
    ? getImageAdapter(config.provider)
    : getVideoAdapter(config.provider)
  const startedAt = Date.now()
  // 记录最后一次轮询的 HTTP 状态，失败详情里给出可排查的状态码
  let lastPollHttpStatus: number | undefined

  for (let i = 0; i < profile.attempts; i++) {
    if (profile.maxDurationMs && Date.now() - startedAt >= profile.maxDurationMs) {
      await failTask(record.id, 'Timeout: Polling exceeded 10 minutes', 'poll_timeout', {
        stage: 'poll',
        message: '轮询超时：等待上游结果超过 10 分钟',
        provider: config.provider,
        model: record.model,
        upstreamTaskId: taskId,
        at: new Date().toISOString(),
        hint: '上游任务可能仍在排队或渲染，请到厂商控制台用任务号核对；确认无结果后可重新生成',
      })
      return
    }
    await new Promise(r => setTimeout(r, profile.intervalMs))
    try {
      const { url, method, headers } = adapter.buildPollRequest(config, taskId, { model: record.model })
      logTaskProgress(label, 'poll-request', {
        id: record.id,
        taskId,
        provider: config.provider,
        method,
        url: redactUrl(url),
        attempt: i + 1,
      })
      const remainingMs = profile.maxDurationMs
        ? Math.max(1_000, profile.maxDurationMs - (Date.now() - startedAt))
        : 600_000
      const resp = await fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(remainingMs),
      })
      if (!resp.ok) {
        lastPollHttpStatus = resp.status
        continue
      }
      const result = await resp.json() as any

      // 图片/视频 PollResponse 结构不同，这里统一按 any 取值后按 type 分支
      const pollResp: any = adapter.parsePollResponse(result)
      if (type === 'video' && pollResp.stage === 'transferring') {
        await db.update(schema.sysTask).set({ stage: 'transferring', updatedAt: now() }).where(eq(schema.sysTask.id, record.id))
      }

      if (pollResp.status === 'completed') {
        if (type === 'image') {
          if (pollResp.imageUrl) {
            logTaskSuccess(label, 'poll-complete', { id: record.id, taskId, imageUrl: pollResp.imageUrl })
            await handleImageComplete(record, pollResp.imageUrl)
            return
          }
          if (adapter.provider === 'gemini') {
            // Gemini 可能返回 base64
            const b64 = (adapter as ReturnType<typeof getImageAdapter>).extractImageBase64(result)
            if (b64) {
              logTaskSuccess(label, 'poll-base64-complete', { id: record.id, taskId, mimeType: b64.mimeType })
              await handleImageCompleteBase64(record, b64.data, b64.mimeType)
              return
            }
          }
        } else {
          // 上游可能只给 file_id（如 MiniMax v1），需要适配器再换一次下载地址
          let videoUrl = pollResp.videoUrl || null
          const videoAdapter = adapter as VideoProviderAdapter
          if (videoAdapter.resolveVideoUrl) {
            videoUrl = await videoAdapter.resolveVideoUrl(config, pollResp, result)
          }
          if (videoUrl) {
            logTaskSuccess(label, 'poll-complete', { id: record.id, taskId, videoUrl })
            await handleVideoComplete(record, videoUrl, pollResp.duration)
            return
          }
        }
      }
      if (pollResp.status === 'failed') {
        // 上游明确失败（如内容审核拦截）属终态：立即落库，不重试不等待超时
        const deliveryFailed = /video_transfer_failed/.test(pollResp.error || '')
        if (deliveryFailed) await db.update(schema.sysTask).set({ stage: 'transferring' }).where(eq(schema.sysTask.id, record.id))
        await failTask(record.id, pollResp.error || 'Generation failed', deliveryFailed ? 'delivery_failed' : 'generation_failed', {
          stage: 'poll',
          message: pollResp.error || '上游任务失败',
          provider: config.provider,
          model: record.model,
          upstreamTaskId: taskId,
          responseBody: previewBody(result),
          at: new Date().toISOString(),
          hint: '上游已明确返回失败：请检查提示词是否触发内容审核、参数是否超出该模型限制；更换模型后重新生成',
        })
        return
      }
    } catch (err: any) {
      const exhausted = i === profile.attempts - 1
        || (profile.maxDurationMs != null && Date.now() - startedAt >= profile.maxDurationMs)
      if (exhausted) {
        await failTask(record.id, `Timeout: ${err.message}`, 'poll_timeout', {
          stage: 'poll',
          message: `轮询失败：${err.message}`,
          provider: config.provider,
          model: record.model,
          upstreamTaskId: taskId,
          httpStatus: lastPollHttpStatus,
          at: new Date().toISOString(),
          hint: '轮询上游任务时持续失败，请用任务号到厂商控制台核对任务状态',
        })
        return
      }
      logTaskWarn(label, 'poll-retry', { id: record.id, taskId, attempt: i + 1, error: err.message })
    }
  }
  await failTask(record.id, 'Timeout: polling attempts exhausted', 'poll_timeout', {
    stage: 'poll',
    message: '轮询次数用尽仍未拿到结果',
    provider: config.provider,
    model: record.model,
    upstreamTaskId: taskId,
    httpStatus: lastPollHttpStatus,
    at: new Date().toISOString(),
    hint: '上游长时间无结果：请到厂商控制台用任务号核对，必要时重新生成',
  })
}

async function handleImageComplete(record: SysTaskRecord, imageUrl: string) {
  const localPath = await downloadFile(imageUrl, 'images')
  // 列表页缩略图（前端按命名约定推导地址，失败不影响主流程）
  await generateImageThumb(localPath)

  await db.update(schema.sysTask)
    .set({ resultUrl: imageUrl, localPath, status: 'completed', completedAt: now(), updatedAt: now() })
    .where(eq(schema.sysTask.id, record.id))

  logTaskSuccess('ImageTask', 'downloaded', { id: record.id, provider: record.provider, localPath })

  await writeBackImageAssets(record, localPath)
}

async function handleImageCompleteBase64(record: SysTaskRecord, base64Data: string, mimeType: string) {
  const localPath = await saveBase64Image(base64Data, mimeType, 'images')
  await generateImageThumb(localPath)

  await db.update(schema.sysTask)
    .set({ localPath, status: 'completed', completedAt: now(), updatedAt: now() })
    .where(eq(schema.sysTask.id, record.id))

  logTaskSuccess('ImageTask', 'saved-base64', { id: record.id, provider: record.provider, mimeType, localPath })

  await writeBackImageAssets(record, localPath)
}

// 图片完成后回写业务表：分镜(按 frameType)、角色、场景、道具
async function writeBackImageAssets(record: SysTaskRecord, localPath: string) {
  const params = parseTaskParams(record.params)
  if (record.storyboardId) {
    const sbUpdate: Record<string, any> = { updatedAt: now() }
    if (params.frameType === 'first_frame') sbUpdate.firstFrameImage = localPath
    else if (params.frameType === 'last_frame') sbUpdate.lastFrameImage = localPath
    else sbUpdate.composedImage = localPath
    await db.update(schema.storyboards).set(sbUpdate).where(eq(schema.storyboards.id, record.storyboardId))
  }
  if (record.characterId) {
    await db.update(schema.characters).set({ imageUrl: localPath, updatedAt: now() }).where(eq(schema.characters.id, record.characterId))
  }
  if (record.sceneId) {
    await db.update(schema.scenes).set({ imageUrl: localPath, status: 'completed', updatedAt: now() }).where(eq(schema.scenes.id, record.sceneId))
  }
  if (record.propId) {
    await db.update(schema.props).set({ imageUrl: localPath, updatedAt: now() }).where(eq(schema.props.id, record.propId))
  }
}

async function handleVideoComplete(record: SysTaskRecord, videoUrl: string, duration: number | null | undefined) {
  // 先落库地址与实际时长；后续下载失败仍可恢复，且不重新提交生成。
  const params = { ...parseTaskParams(record.params), resultDuration: duration }
  await db.update(schema.sysTask).set({ resultUrl: videoUrl, params: JSON.stringify(params),
    stage: 'downloading', status: 'processing', errorCode: null, errorMsg: null, updatedAt: now() })
    .where(eq(schema.sysTask.id, record.id))
  try {
    const localPath = record.localPath && fs.existsSync(getAbsolutePath(record.localPath))
      ? record.localPath : await downloadVideo(videoUrl, record.id)
    await db.update(schema.sysTask).set({ localPath, stage: 'saving', updatedAt: now() }).where(eq(schema.sysTask.id, record.id))
    await extractVideoPoster(localPath)
    // 完成状态与业务回写原子提交；恢复旧任务不能覆盖用户后来生成的视频。
    db.transaction(tx => {
      const newer = record.storyboardId ? tx.select({ id: schema.sysTask.id }).from(schema.sysTask)
        .where(and(eq(schema.sysTask.storyboardId, record.storyboardId), eq(schema.sysTask.type, 'video'), gt(schema.sysTask.id, record.id))).get() : null
      if (record.storyboardId && !newer) tx.update(schema.storyboards)
        .set({ videoUrl: localPath, duration: duration || undefined, updatedAt: now() })
        .where(eq(schema.storyboards.id, record.storyboardId)).run()
      tx.update(schema.sysTask).set({ localPath, status: 'completed', stage: 'completed', errorCode: null,
        errorMsg: null, completedAt: now(), updatedAt: now() }).where(eq(schema.sysTask.id, record.id)).run()
    })
  } catch (error) {
    await failTask(record.id, safeTaskError(error), 'delivery_failed', {
      stage: 'download',
      message: safeTaskError(error),
      provider: record.provider,
      model: record.model,
      upstreamTaskId: record.taskId,
      at: new Date().toISOString(),
      hint: '上游已生成成功但结果下载/落盘失败：请点击「恢复」重试下载，通常无需重新生成（避免二次计费）',
    })
  }
}

async function recoveryConfig(record: SysTaskRecord): Promise<AIConfig> {
  if (record.configId) {
    const config = await getConfigById(record.configId)
    if (config && config.provider === record.provider && config.baseUrl === record.configBaseUrl) return config
    throw new Error('原视频服务配置已删除、停用或地址变更，请恢复原配置')
  }
  // 旧任务只在同厂商唯一配置时恢复，绝不任意换服务商查询。
  const rows = (await db.select().from(schema.aiServiceConfigs)).filter(c => c.isActive && c.serviceType === 'video' && c.provider === record.provider)
  if (rows.length === 1) {
    const config = await getConfigById(rows[0].id)
    if (config) return config
  }
  throw new Error('历史任务无法确定原服务配置，请先核对配置')
}

export async function recoverVideoTask(id: number): Promise<void> {
  const [record] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
  if (!record || record.type !== 'video') throw new Error('视频任务不存在')
  if (activeTasks.has(id) || record.status === 'completed') return
  if (!record.resultUrl && !record.taskId) throw new Error('未保存上游任务编号，请先核对上游记录，勿重复生成')
  if (record.errorCode === 'generation_failed') throw new Error('上游已确认生成失败，无法恢复原任务')
  // 在任何异步配置读取前获取锁，重复点击不会启动多个下载。
  activeTasks.add(id)
  try {
    const config = record.taskId && !record.resultUrl ? await recoveryConfig(record) : null
    await db.update(schema.sysTask).set({ status: 'processing', errorMsg: null, errorCode: null,
      stage: record.resultUrl ? 'downloading' : record.stage === 'transferring' || record.errorCode === 'delivery_failed' ? 'transferring' : 'polling', updatedAt: now() }).where(eq(schema.sysTask.id, id))
    void (async () => {
      if (record.resultUrl) {
        await handleVideoComplete(record, record.resultUrl, parseTaskParams(record.params).resultDuration)
        const [fresh] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
        if (fresh?.status !== 'failed' || !record.taskId) return
        // 签名链接可能过期：重新查询原任务拿新地址。
      }
      const originalConfig = config ?? await recoveryConfig(record)
      // 交付恢复是厂商特有的独立接口（仅部分厂商/模型支持），由适配器声明是否支持。
      if ((record.errorCode === 'delivery_failed' || record.stage === 'transferring') && !record.resultUrl) {
        const adapter = getVideoAdapter(record.provider || '')
        if (adapter.buildRecoveryRequest) {
          const req = adapter.buildRecoveryRequest(originalConfig, record.taskId!, { model: record.model })
          const resp = await fetch(req.url, { method: req.method, headers: req.headers, signal: AbortSignal.timeout(30_000) })
          if (!resp.ok) throw new Error(`Video delivery recovery HTTP ${resp.status}`)
        }
      }
      await markPolling(id, record.taskId!)
      await pollTask(record, originalConfig, record.taskId!)
    })().catch(error => failTask(id, safeTaskError(error), 'recovery_failed', {
      stage: 'download',
      message: safeTaskError(error),
      provider: record.provider,
      model: record.model,
      upstreamTaskId: record.taskId,
      at: new Date().toISOString(),
      hint: '恢复原任务失败：请核对原服务配置是否仍然有效，以及上游任务号是否已过期',
    })).finally(() => activeTasks.delete(id))
  } catch (error) {
    activeTasks.delete(id)
    throw error
  }
}

export async function resumeInterruptedTasks() {
  const tasks = await db.select().from(schema.sysTask).where(eq(schema.sysTask.status, 'processing')).orderBy(desc(schema.sysTask.id))
  for (const task of tasks) {
    if (task.type === 'video' && (task.taskId || task.resultUrl)) {
      try { await recoverVideoTask(task.id) } catch (error) { await failTask(task.id, safeTaskError(error), 'recovery_failed') }
    } else {
      await failTask(task.id, task.type === 'video' ? '服务中断，提交结果待确认，请先核对上游记录' : '服务重启，生成任务中断，请重试',
        task.type === 'video' ? 'submission_unknown' : 'interrupted')
    }
  }
}

// ─── 参考素材归一化 ───────────────────────────────────────────────

async function normalizeReferenceImages(refs: string[] | null | undefined): Promise<string[]> {
  if (!Array.isArray(refs) || !refs.length) return []

  const deduped = Array.from(
    new Set(
      refs
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  )

  const normalized = await Promise.all(deduped.map(async (value) => {
    if (value.startsWith('data:image/')) return value
    if (value.startsWith('static/') || value.startsWith('/static/')) {
      const localPath = value.startsWith('/static/') ? value.slice(1) : value
      try {
        return await readImageAsCompressedDataUrl(localPath, {
          maxWidth: 768,
          maxHeight: 768,
          quality: 68,
        })
      } catch (err) {
        logTaskWarn('ImageTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
        return null
      }
    }
    // 远程 URL：下载压缩为 data URL，保证 multipart 上传（OpenAI edits）/ inline_data（Gemini）都可用
    if (/^https?:\/\//.test(value)) {
      try {
        return await fetchImageAsCompressedDataUrl(value, {
          maxWidth: 768,
          maxHeight: 768,
          quality: 68,
        })
      } catch (err) {
        logTaskWarn('ImageTask', 'reference-fetch-failed', { url: value, error: (err as Error).message })
        return null
      }
    }
    return value
  }))

  return normalized.filter((item): item is string => !!item).slice(0, 6)
}

async function normalizeVideoReferenceUrl(value: string | null | undefined): Promise<string | null> {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.startsWith('data:image/')) return raw
  if (raw.startsWith('static/') || raw.startsWith('/static/')) {
    const localPath = raw.startsWith('/static/') ? raw.slice(1) : raw
    try {
      // 视频参考图直接编码原文件，保留原始尺寸、格式、透明通道和画质。
      return readImageAsDataUrl(localPath)
    } catch (err) {
      logTaskWarn('VideoTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
      return null
    }
  }
  return raw
}

async function normalizeVideoReferenceUrls(refs: string[] | null | undefined): Promise<string[]> {
  if (!Array.isArray(refs) || !refs.length) return []
  const normalized = await Promise.all(
    Array.from(new Set(refs.map((item) => String(item || '').trim()).filter(Boolean))).map((item) => normalizeVideoReferenceUrl(item)),
  )
  return normalized.filter((item): item is string => !!item)
}

/**
 * 将参考视频/音频解析为 Seedance API 可访问的 URL。
 * http(s)/dataURL 直通；本地 static 路径需要 PUBLIC_BASE_URL 拼成公网地址，
 * 未配置时抛出可操作的中文错误（落入 catch 写入 error_msg 供前端展示）。
 */
function resolvePublicMediaUrl(value: string | null | undefined, kind: 'video' | 'audio' | 'file' | 'image'): string | null {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:')) return raw
  if (raw.startsWith('static/') || raw.startsWith('/static/')) {
    const base = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '')
    if (!base) {
      const label = kind === 'video' ? '视频' : kind === 'audio' ? '音频' : kind === 'image' ? '图片' : '文件'
      throw new ProviderError({
        stage: 'config',
        message: `参考${label}为本地路径 ${raw}，但后端未配置 PUBLIC_BASE_URL，上游生成 API 无法访问内网地址。`,
        hint: '在 backend/.env 配置 PUBLIC_BASE_URL（如 https://your-domain.com）后重试，或改用公网 URL',
      })
    }
    const p = raw.startsWith('/') ? raw : `/${raw}`
    return `${base}${p}`
  }
  return raw
}

function resolvePublicMediaUrls(refs: string[] | null | undefined, kind: 'video' | 'audio' | 'image'): string[] {
  if (!Array.isArray(refs) || !refs.length) return []
  const items = Array.from(new Set(refs.map((item) => String(item || '').trim()).filter(Boolean)))
  return items.map((item) => resolvePublicMediaUrl(item, kind)).filter((item): item is string => !!item)
}

/**
 * 图片参考素材 → 公网 URL（MiniMax subject_reference 专用）
 * 与 resolvePublicMediaUrl 同源，区别在于缺失 PUBLIC_BASE_URL 时给出图片专用的提示。
 */
function resolvePublicReferenceImages(refs: string[] | null | undefined): string[] {
  if (!Array.isArray(refs) || !refs.length) return []
  const items = Array.from(new Set(refs.map((item) => String(item || '').trim()).filter(Boolean)))
  return items.map((item) => resolvePublicMediaUrl(item, 'image')).filter((item): item is string => !!item)
}

function normalizeStoredVideoResolution(resolution: string | null | undefined): string | undefined {
  const value = String(resolution || '').trim().toLowerCase()
  if (value === '480p' || value === '720p' || value === '1080p') return value
  if (value === '2k') return '2K'
  return undefined
}
