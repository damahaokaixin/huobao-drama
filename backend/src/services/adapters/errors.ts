/**
 * Provider 调用错误 — 携带结构化失败详情
 *
 * 目的：任务失败时不再只落一句「任务失败」，而是把
 * 「失败发生在哪个环节 / HTTP 状态码 / 厂商错误码 / 请求与响应原文 / 可操作建议」
 * 一起持久化到 sys_task.error_detail，前端可直接展开查看。
 */

/** 失败环节 */
export type ProviderErrorStage =
  | 'config'      // 本地参数校验（提示词、参考素材、模型名等）
  | 'request'     // 发起请求（网络错误、超时）
  | 'auth'        // 鉴权失败（401/403）
  | 'quota'       // 额度/限流（402/429）
  | 'response'    // 上游返回业务错误（HTTP 200 但 base_resp 非 0）
  | 'poll'        // 轮询阶段失败
  | 'download'    // 结果下载/落盘失败
  | 'unknown'

export interface ProviderErrorDetail {
  /** 失败环节 */
  stage: ProviderErrorStage
  /** 面向用户的失败原因（一句话） */
  message: string
  /** HTTP 状态码（网络层失败时为 undefined） */
  httpStatus?: number
  /** 厂商业务错误码（MiniMax 的 base_resp.status_code 等） */
  providerCode?: string | number
  /** 厂商错误原文 */
  providerMessage?: string
  /** 实际请求的 URL（已脱敏） */
  requestUrl?: string
  /** 请求体摘要（已脱敏，base64/大字段截断） */
  requestBody?: unknown
  /** 响应体摘要（已脱敏，截断） */
  responseBody?: unknown
  /** 可操作的排查建议 */
  hint?: string
  /** 发生时的厂商 */
  provider?: string | null
  /** 发生时的模型 */
  model?: string | null
  /** 上游任务号（异步任务失败时用于到厂商控制台核对） */
  upstreamTaskId?: string | null
  /** 发生时��戳 */
  at: string
}

export interface ProviderErrorInit {
  stage: ProviderErrorStage
  message: string
  httpStatus?: number
  providerCode?: string | number
  providerMessage?: string
  requestUrl?: string
  requestBody?: unknown
  responseBody?: unknown
  hint?: string
}

/** 截断响应体，避免把 base64 图片/大 JSON 整个写进数据库 */
export function previewBody(value: unknown, limit = 2000): unknown {
  if (value == null) return value
  if (typeof value === 'string') {
    return value.length > limit ? `${value.slice(0, limit)}…<truncated ${value.length} chars>` : value
  }
  try {
    const json = JSON.stringify(value, replacer)
    if (json.length <= limit) return value
    return `${json.slice(0, limit)}…<truncated ${json.length} chars>`
  } catch {
    return String(value).slice(0, limit)
  }
}

function replacer(_key: string, value: unknown) {
  if (typeof value === 'string') {
    if (value.startsWith('data:')) return `<data-uri ${value.length} chars>`
    if (value.length > 400) return `${value.slice(0, 400)}…<trimmed ${value.length} chars>`
  }
  return value
}

/** 脱敏：去掉 key/token/签名等敏感串 */
export function redactSecrets(value: unknown): unknown {
  if (value == null) return value
  if (typeof value === 'string') {
    return value
      .replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
      .replace(/\bsk-[\w-]+/g, '[redacted]')
      .replace(/((?:api[_-]?key|signature|token|secret)["']?\s*[:=]\s*["']?)[^\s,"'}&]+/gi, '$1[redacted]')
  }
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lower = k.toLowerCase()
      if (lower.includes('authorization') || lower.includes('api_key') || lower.includes('apikey') || lower === 'token') {
        out[k] = '[redacted]'
        continue
      }
      out[k] = redactSecrets(v)
    }
    return out
  }
  return value
}

/**
 * 带结构化详情的 Provider 错误
 * 抛出时携带 detail，generation.ts 捕获后落库
 */
export class ProviderError extends Error {
  readonly detail: ProviderErrorDetail

  constructor(init: ProviderErrorInit) {
    super(init.message)
    this.name = 'ProviderError'
    this.detail = {
      stage: init.stage,
      message: init.message,
      httpStatus: init.httpStatus,
      providerCode: init.providerCode,
      providerMessage: init.providerMessage,
      requestUrl: init.requestUrl,
      requestBody: redactSecrets(previewBody(init.requestBody)),
      responseBody: redactSecrets(previewBody(init.responseBody)),
      hint: init.hint,
      at: new Date().toISOString(),
    }
  }

  static isProviderError(error: unknown): error is ProviderError {
    return error instanceof ProviderError
  }
}

/** 从任意异常里提取结构化详情（普通 Error 也会生成一个最小可用详情） */
export function toProviderErrorDetail(error: unknown, fallbackStage: ProviderErrorStage = 'unknown'): ProviderErrorDetail {
  if (ProviderError.isProviderError(error)) return error.detail
  const message = error instanceof Error ? error.message : String(error || 'Unknown failure')
  return {
    stage: fallbackStage,
    message,
    at: new Date().toISOString(),
  }
}
