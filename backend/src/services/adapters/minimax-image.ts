/**
 * MiniMax 图片生成 Adapter（image-01 / image-01-live）
 * 端点: POST /v1/image_generation
 * 响应: { id, data: { image_urls: [...] | image_base64: [...] }, metadata: {...}, base_resp: {...} }
 *
 * MiniMax 图片接口是同步返回的（没有任务轮询）：
 * - response_format='url'    → data.image_urls[]
 * - response_format='base64' → data.image_base64[]
 *
 * 模型差异（官方口径）：
 * - image-01       文生图 + 图生图（人物主体参考）
 * - image-01-live  在 image-01 基础上额外支持画风设置（style.style_type）
 *
 * 图生图（参考图）走 subject_reference：
 * - 只支持 1 张参考图
 * - 参考图必须是公网可访问的 http(s) URL（data URL 会被上游拒绝）
 *
 * 业务错误全部藏在 base_resp 里，HTTP 200 也可能是失败，必须显式校验。
 */
import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types'
import { joinProviderUrl } from './url'
import { assertMiniMaxOk, getMiniMaxImageProfile, parseBaseResp } from './minimax-common'
import { ProviderError } from './errors'

const DEFAULT_MODEL = 'image-01'

/** MiniMax 支持的宽高比 */
const VALID_RATIOS = new Set(['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'])

/** 提示词长度上限（官方 1~1500 字符） */
const PROMPT_MAX_CHARS = 1500

/** 宽高像素范围与 8 的倍数约束 */
const MIN_SIDE = 512
const MAX_SIDE = 2048

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string' && u.trim()) : []
  } catch {
    return []
  }
}

/** 依据项目 size（形如 1920x1080）推导 MiniMax 的 width/height 或 aspect_ratio */
function resolveDimensions(size?: string | null): { width?: number; height?: number; aspect_ratio?: string } {
  const raw = String(size || '').trim().toLowerCase()
  if (!raw) return { aspect_ratio: '16:9' }
  const m = raw.match(/^(\d+)\s*[x*×]\s*(\d+)$/)
  if (m) {
    const w = Number(m[1])
    const h = Number(m[2])
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      // 落在官方像素区间且能被 8 整除时，用精确尺寸
      const wOk = w >= MIN_SIDE && w <= MAX_SIDE && w % 8 === 0
      const hOk = h >= MIN_SIDE && h <= MAX_SIDE && h % 8 === 0
      if (wOk && hOk) return { width: w, height: h }
      // 越界时按比例缩放到合法区间（保持画面比例，而不是拉伸或丢比例）
      const scale = Math.max(MIN_SIDE / w, MIN_SIDE / h, w / MAX_SIDE, h / MAX_SIDE)
      const align8 = (v: number) => Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round((v * scale) / 8) * 8))
      return { width: align8(w), height: align8(h) }
    }
  }
  // 退化为宽高比
  const ratio = raw.replace(/\s/g, '')
  if (VALID_RATIOS.has(ratio)) return { aspect_ratio: ratio }
  return { aspect_ratio: '16:9' }
}

export class MiniMaxImageAdapter implements ImageProviderAdapter {
  provider = 'minimax'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const model = (record.model || config.model || DEFAULT_MODEL).trim()
    const prompt = String(record.prompt || '').trim()
    const profile = getMiniMaxImageProfile(model)

    if (!prompt) {
      throw new ProviderError({
        stage: 'config',
        message: 'MiniMax 生图需要提示词',
        hint: '请在生图任务中填写提示词',
      })
    }
    if (prompt.length > PROMPT_MAX_CHARS) {
      throw new ProviderError({
        stage: 'config',
        message: `提示词超长：MiniMax ${model} 上限 ${PROMPT_MAX_CHARS} 字符，当前 ${prompt.length}`,
        hint: '请精简提示词，或改用支持更长提示词的模型',
      })
    }

    const body: any = {
      model,
      prompt,
      n: 1,
      response_format: 'url',
      prompt_optimizer: false,
    }

    const dims = resolveDimensions(record.size)
    if (dims.width && dims.height) {
      body.width = dims.width
      body.height = dims.height
    } else {
      body.aspect_ratio = dims.aspect_ratio
    }

    // 画风设置：仅 image-01-live 支持
    const style = String(record.style || '').trim()
    if (style) {
      if (!profile.supportsStyle) {
        throw new ProviderError({
          stage: 'config',
          message: `MiniMax ${model} 不支持画风设置（style.style_type）`,
          hint: `画风设置仅 image-01-live 支持，可选画风：${profile.styleTypes.length ? profile.styleTypes.join(' / ') : '漫画 / 元气 / 中世纪 / 水彩'}`,
        })
      }
      if (!profile.styleTypes.includes(style)) {
        throw new ProviderError({
          stage: 'config',
          message: `不支持的画风：${style}`,
          hint: `image-01-live 可选画风：${profile.styleTypes.join(' / ')}`,
        })
      }
      body.style = { style_type: style }
    }

    // 参考图 → subject_reference（官方只支持 1 张，且必须是公网 URL）
    const references = parseUrlArray(record.referenceImages)
    if (references.length) {
      if (references.length > 1) {
        throw new ProviderError({
          stage: 'config',
          message: `MiniMax 参考图最多 1 张，当前 ${references.length} 张`,
          hint: '如需保持角色一致性，请只保留一张角色参考图',
        })
      }
      if (!profile.supportsReference) {
        throw new ProviderError({
          stage: 'config',
          message: `MiniMax ${model} 不支持参考图（subject_reference）`,
          hint: '如需图生图，请改用 image-01 模型',
        })
      }
      const ref = references[0]
      if (ref.startsWith('data:')) {
        throw new ProviderError({
          stage: 'config',
          message: 'MiniMax 参考图需要公网可访问的图片 URL，当前是内联 data URL',
          hint: '在 backend/.env 配置 PUBLIC_BASE_URL（如 https://your-domain.com）后重试，MiniMax 才能拉取参考图',
        })
      }
      body.subject_reference = [{ type: 'character', image_file: ref }]
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/image_generation'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    assertMiniMaxOk(result, { stage: 'response' })

    const urls: string[] = Array.isArray(result?.data?.image_urls) ? result.data.image_urls : []
    if (urls.length) return { isAsync: false, imageUrl: urls[0] }

    // 同步模式下也可能直接给 base64（此时由 extractImageBase64 兜底）
    const b64: string[] = Array.isArray(result?.data?.image_base64) ? result.data.image_base64 : []
    if (b64.length) return { isAsync: false }

    const { statusCode, statusMsg } = parseBaseResp(result)
    throw new ProviderError({
      stage: 'response',
      message: statusMsg?.trim() || 'MiniMax 未返回图片地址（data.image_urls 为空）',
      providerCode: statusCode,
      providerMessage: statusMsg,
      responseBody: result,
      hint: '请确认模型名可用（image-01），并检查提示词是否被内容审核拦截',
    })
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    throw new ProviderError({
      stage: 'config',
      message: 'MiniMax 图片接口为同步返回，无需轮询',
      requestUrl: joinProviderUrl(config.baseUrl, '/v1', '/image_generation'),
      hint: '如上游返回了任务号，请确认 Base URL 指向的是 MiniMax 官方 /v1/image_generation 而非异步代理',
    })
  }

  parsePollResponse(result: any): ImagePollResponse {
    assertMiniMaxOk(result, { stage: 'poll' })
    const url = this.extractImageUrl(result)
    if (url) return { status: 'completed', imageUrl: url }
    return { status: 'processing' }
  }

  extractImageUrl(result: any): string | null {
    const urls = result?.data?.image_urls
    if (Array.isArray(urls) && urls.length) return urls[0]
    return result?.data?.image_url || result?.image_url || null
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    const list = result?.data?.image_base64
    if (Array.isArray(list) && list.length) return { data: list[0], mimeType: 'image/jpeg' }
    if (typeof result?.data?.image_base64 === 'string' && result.data.image_base64) {
      return { data: result.data.image_base64, mimeType: 'image/jpeg' }
    }
    return null
  }
}
