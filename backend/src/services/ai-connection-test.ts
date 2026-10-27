/**
 * AI 服务「真实连通性测试」
 *
 * 与旧版的 probe（发个空请求看端点是否可达）不同，这里做的是**真实调用**：
 * - text  : 发一次最小 Chat Completion，校验真的返回了内容
 * - image : 发一次真实生图（1 张，最短提示词），校验真的拿到了图片
 * - video : 真实提交一次视频任务并短轮询，校验任务被上游接受
 *
 * 返回结构统一为「结论 + 耗时 + 环节 + 原始响应 + 可操作建议」，
 * 前端可直接展示，让用户知道到底为什么失败，而不是只看到一个「保存失败」。
 */
import { joinProviderUrl } from './adapters/url.js'
import { parseBaseResp, hintForCode, getH3Profile, getClassicVideoProfile } from './adapters/minimax-common.js'
import {
  detectMiniMaxKeyType,
  planBillingHint,
  planCoverageHint,
  type MiniMaxKeyType,
} from './adapters/minimax-plan.js'
import { ProviderError, previewBody, redactSecrets } from './adapters/errors.js'
import { logTaskError, logTaskSuccess, redactUrl } from '../utils/task-logger.js'

export type TestStage = 'config' | 'auth' | 'request' | 'quota' | 'response' | 'poll' | 'success'

export interface ConnectionTestResult {
  /** 真实调用是否成功 */
  ok: boolean
  /** 端点是否可达（HTTP 有响应即视为可达，保持与旧版前端兼容） */
  reachable: boolean
  service_type: string
  provider: string
  model: string
  /** HTTP 状态码 */
  status: number | null
  /** 失败/成功发生在哪个环节 */
  stage: TestStage
  /** 人类可读结论 */
  message: string
  /** 实际请求的方法与 URL（已脱敏） */
  method: string
  url: string
  /** 往返耗时（毫秒） */
  latency_ms: number
  /** 响应体摘要 */
  response_preview: string
  /** 结构化补充信息（token 用量、图片地址、任务号等） */
  detail: Record<string, unknown>
  /** 失败时的可操作建议 */
  suggestion?: string
  /** 厂商错误码 */
  provider_code?: string | number
  /** 厂商错误原文 */
  provider_message?: string
  /** 识别到的计费类型（仅 MiniMax 填：subscription / payg / unknown） */
  key_type?: MiniMaxKeyType
}

export interface ConnectionTestInput {
  serviceType: string
  provider: string
  baseUrl: string
  apiKey?: string
  model?: string
  /** video 测试的轮询上限（毫秒），默认 90s */
  pollTimeoutMs?: number
}

/** 视频测试用的最短提示词 */
const VIDEO_TEST_PROMPT = 'A red apple on a white table, slow camera push in'
/** 图片测试用的最短提示词 */
const IMAGE_TEST_PROMPT = 'A red apple on a white table'
/** 文本测试用的问题 */
const TEXT_TEST_PROMPT = 'ping'

function nowMs() {
  return Date.now()
}

function bearer(apiKey?: string, json = true): Record<string, string> {
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  if (json) headers['Content-Type'] = 'application/json'
  return headers
}

function preview(value: unknown, limit = 2000): string {
  if (value == null) return ''
  if (typeof value === 'string') return value.slice(0, limit)
  try {
    return JSON.stringify(redactSecrets(previewBody(value, limit)))
  } catch {
    return String(value).slice(0, limit)
  }
}

function baseResult(input: ConnectionTestInput, method: string, url: string): ConnectionTestResult {
  return {
    ok: false,
    reachable: false,
    service_type: input.serviceType,
    provider: input.provider,
    model: input.model || '',
    status: null,
    stage: 'config',
    message: '',
    method,
    url: redactUrl(url),
    latency_ms: 0,
    response_preview: '',
    detail: {},
  }
}

/** 按 HTTP 状态码推断失败环节与建议 */
function classifyHttpStatus(status: number, provider: string, keyType: MiniMaxKeyType = 'unknown'): { stage: TestStage; suggestion: string } {
  if (status === 401 || status === 403) {
    return {
      stage: 'auth',
      suggestion: provider === 'minimax'
        ? '鉴权失败：请确认 Key 正确、已生效，且 Key 类型与区域匹配（国内 api.minimaxi.com / 国际 api.minimax.io 不可混用；订阅 Key 为 sk-cp 开头，按量 Key 为 sk-api 开头）'
        : '鉴权失败：请确认 API Key 正确、已生效，且该 Key 已开通对应模型权限（MiniMax 可在「模型广场」确认）',
    }
  }
  if (status === 404) {
    return {
      stage: 'config',
      suggestion: '端点 404：请检查 Base URL 与版本路径是否正确（MiniMax 文本用 /v1，图片 /v1/image_generation，视频 /v1 或 /v2）',
    }
  }
  if (status === 429) {
    return { stage: 'quota', suggestion: '触发限流：请降低调用频率或稍后重试' }
  }
  if (status === 402) {
    if (provider === 'minimax' && keyType === 'subscription') {
      return {
        stage: 'quota',
        suggestion: '订阅额度已用尽且无可用积分包：请等待额度窗口重置、购买积分包，或改用按量计费 API Key（sk-api 开头）',
      }
    }
    if (provider === 'minimax' && keyType === 'payg') {
      return {
        stage: 'quota',
        suggestion: '账户余额不足：请前往 MiniMax 开放平台「财务管理」充值。注意使用订阅 Key（sk-cp 开头）走套餐额度不会扣账户余额',
      }
    }
    return { stage: 'quota', suggestion: '账户余额不足：请前往厂商控制台充值' }
  }
  if (status >= 500) {
    return { stage: 'response', suggestion: '厂商服务端异常（5xx），请稍后重试或联系厂商' }
  }
  return { stage: 'response', suggestion: `请根据响应体核对 ${provider} 的请求参数与模型名` }
}

/**
 * MiniMax 专属的失败归因：
 * 1. 依据 Key 类型修正「余额不足 / 额度用尽」这类误导性提示
 * 2. 依据订阅套餐覆盖范围修正「模型无权限」提示
 */
function applyMiniMaxPlanHint(
  result: ConnectionTestResult,
  model: string,
  keyType: MiniMaxKeyType,
): void {
  if (keyType !== 'unknown') {
    result.key_type = keyType
    result.detail.key_type = keyType
  }
  const code = typeof result.provider_code === 'number' ? result.provider_code : undefined
  const billing = planBillingHint(code, result.provider_message, keyType)
  if (billing) {
    result.suggestion = billing
    if (code === 2056 || code === 2062 || code === 1008) result.stage = 'quota'
  }
  // 订阅 Key + H3：老版 Token Plan 不覆盖 H3，需要给出套餐层面的解释
  if (code === 1039 || code === 1004) {
    const coverage = planCoverageHint(model)
    if (coverage) {
      result.suggestion = `${coverage}（当前使用的 Key 类型：${keyType === 'subscription' ? '订阅 Key' : keyType === 'payg' ? '按量计费 Key' : '未知'}）`
    }
  }
}

/**
 * 执行真实连通性测试
 */
export async function runConnectionTest(input: ConnectionTestInput): Promise<ConnectionTestResult> {
  const provider = (input.provider || '').toLowerCase()
  const serviceType = input.serviceType
  const model = (input.model || '').trim()

  if (!input.baseUrl) {
    const r = baseResult(input, '—', '')
    r.stage = 'config'
    r.message = '缺少 Base URL'
    r.suggestion = '请填写厂商 API 地址（如 MiniMax 国内站 https://api.minimaxi.com）'
    return r
  }
  if (!input.apiKey) {
    const r = baseResult(input, '—', input.baseUrl)
    r.stage = 'auth'
    r.message = '缺少 API Key'
    r.suggestion = '请填写 API Key 后再测试'
    return r
  }
  if (!model) {
    const r = baseResult(input, '—', input.baseUrl)
    r.stage = 'config'
    r.message = '未选择模型'
    r.suggestion = '请至少添加一个模型名，测试会真实调用该模型'
    return r
  }

  const keyType: MiniMaxKeyType = provider === 'minimax' ? detectMiniMaxKeyType(input.apiKey) : 'unknown'

  try {
    let result: ConnectionTestResult
    if (serviceType === 'text') result = await testText(input, provider, model, keyType)
    else if (serviceType === 'image') result = await testImage(input, provider, model, keyType)
    else if (serviceType === 'video') result = await testVideo(input, provider, model, keyType)
    else {
      const r = baseResult(input, '—', input.baseUrl)
      r.stage = 'config'
      r.message = `未知的服务类型：${serviceType}`
      r.suggestion = '仅支持 text / image / video'
      return r
    }
    // MiniMax：按 Key 类型与套餐覆盖范围修正失败归因
    if (provider === 'minimax') applyMiniMaxPlanHint(result, model, keyType)
    return result
  } catch (error: any) {
    const r = baseResult(input, '—', input.baseUrl)
    r.stage = 'request'
    r.message = error?.message || String(error || '请求失败')
    r.suggestion = '网络请求失败：请检查 Base URL、网络连通性与代理设置'
    if (error instanceof ProviderError) {
      r.stage = error.detail.stage as TestStage
      r.message = error.detail.message
      r.provider_code = error.detail.providerCode
      r.provider_message = error.detail.providerMessage
      r.suggestion = error.detail.hint
      r.response_preview = preview(error.detail.responseBody)
      r.url = error.detail.requestUrl ? redactUrl(error.detail.requestUrl) : r.url
    }
    if (provider === 'minimax') applyMiniMaxPlanHint(r, model, keyType)
    return r
  }
}

// ─── 文本 ────────────────────────────────────────────────────────

async function testText(input: ConnectionTestInput, provider: string, model: string, keyType: MiniMaxKeyType = 'unknown'): Promise<ConnectionTestResult> {
  const { method, url, body } = buildTextRequest(input, provider, model)
  const result = baseResult(input, method, url)
  const started = nowMs()

  const resp = await fetch(url, {
    method,
    headers: bearer(input.apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await resp.text()
  result.latency_ms = nowMs() - started
  result.status = resp.status
  result.reachable = true
  result.response_preview = preview(text)

  if (!resp.ok) {
    const { stage, suggestion } = classifyHttpStatus(resp.status, provider, keyType)
    result.stage = stage
    result.message = `HTTP ${resp.status} ${resp.statusText || ''}`.trim()
    result.suggestion = suggestion
    const parsed = safeJson(text)
    const base = parseBaseResp(parsed)
    if (base.statusCode != null && base.statusCode !== 0) {
      result.provider_code = base.statusCode
      result.provider_message = base.statusMsg
      result.message = base.statusMsg || result.message
      result.suggestion = hintForCode(base.statusCode, base.statusMsg) || suggestion
    }
    return result
  }

  const parsed = safeJson(text)
  const base = parseBaseResp(parsed)
  if (base.statusCode != null && base.statusCode !== 0) {
    result.stage = 'response'
    result.provider_code = base.statusCode
    result.provider_message = base.statusMsg
    result.message = base.statusMsg || `厂商返回错误码 ${base.statusCode}`
    result.suggestion = hintForCode(base.statusCode, base.statusMsg)
    return result
  }

  const content = extractTextContent(parsed)
  if (!content) {
    result.stage = 'response'
    result.message = '请求成功但未解析到文本内容'
    result.suggestion = '请确认模型名可用（部分厂商需要开通对应模型权限）'
    return result
  }

  result.ok = true
  result.stage = 'success'
  result.message = `真实调用成功，模型返回了 ${content.length} 个字符`
  result.detail = {
    reply: content.slice(0, 200),
    usage: parsed?.usage ?? null,
    model: parsed?.model ?? model,
  }
  return result
}

function buildTextRequest(input: ConnectionTestInput, provider: string, model: string) {
  if (provider === 'gemini') {
    const url = new URL(joinProviderUrl(input.baseUrl, '/v1beta', `/models/${model}:generateContent`))
    if (input.apiKey) url.searchParams.set('key', input.apiKey)
    return {
      method: 'POST',
      url: url.toString(),
      body: { contents: [{ parts: [{ text: TEXT_TEST_PROMPT }] }], generationConfig: { maxOutputTokens: 16 } },
    }
  }
  if (provider === 'volcengine') {
    return {
      method: 'POST',
      url: joinProviderUrl(input.baseUrl, '/api/v3', '/chat/completions'),
      body: { model, messages: [{ role: 'user', content: TEXT_TEST_PROMPT }], max_tokens: 16 },
    }
  }
  // openai / minimax 走 OpenAI 兼容协议
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: TEXT_TEST_PROMPT }],
  }
  // MiniMax 的 OpenAI 兼容接口只认 max_completion_tokens
  if (provider === 'minimax') {
    body.max_completion_tokens = 16
    // M3 系默认开启思考，若不关掉，16 token 的输出额度会被思考内容吃光导致正文为空
    if (/^minimax-m3/i.test(model)) body.thinking = { type: 'disabled' }
  } else {
    body.max_tokens = 16
  }
  return {
    method: 'POST',
    url: joinProviderUrl(input.baseUrl, '/v1', '/chat/completions'),
    body,
  }
}

function extractTextContent(parsed: any): string {
  if (!parsed) return ''
  const choice = parsed?.choices?.[0]
  const content = choice?.message?.content ?? choice?.text ?? choice?.delta?.content
  if (typeof content === 'string' && content.trim()) return content
  // Gemini 原生结构
  const parts = parsed?.candidates?.[0]?.content?.parts
  if (Array.isArray(parts)) {
    const joined = parts.map((p: any) => p?.text || '').join('').trim()
    if (joined) return joined
  }
  return ''
}

// ─── 图片 ────────────────────────────────────────────────────────

async function testImage(input: ConnectionTestInput, provider: string, model: string, keyType: MiniMaxKeyType = 'unknown'): Promise<ConnectionTestResult> {
  const { method, url, body } = buildImageRequest(input, provider, model)
  const result = baseResult(input, method, url)
  const started = nowMs()

  const resp = await fetch(url, {
    method,
    headers: bearer(input.apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  })
  const text = await resp.text()
  result.latency_ms = nowMs() - started
  result.status = resp.status
  result.reachable = true
  result.response_preview = preview(text)

  if (!resp.ok) {
    const { stage, suggestion } = classifyHttpStatus(resp.status, provider, keyType)
    result.stage = stage
    result.message = `HTTP ${resp.status} ${resp.statusText || ''}`.trim()
    result.suggestion = suggestion
    const base = parseBaseResp(safeJson(text))
    if (base.statusCode != null && base.statusCode !== 0) {
      result.provider_code = base.statusCode
      result.provider_message = base.statusMsg
      result.message = base.statusMsg || result.message
      result.suggestion = hintForCode(base.statusCode, base.statusMsg) || suggestion
    }
    return result
  }

  const parsed = safeJson(text)
  const base = parseBaseResp(parsed)
  if (base.statusCode != null && base.statusCode !== 0) {
    result.stage = 'response'
    result.provider_code = base.statusCode
    result.provider_message = base.statusMsg
    result.message = base.statusMsg || `厂商返回错误码 ${base.statusCode}`
    result.suggestion = hintForCode(base.statusCode, base.statusMsg)
    return result
  }

  const imageUrl = extractImageUrl(parsed)
  if (!imageUrl) {
    result.stage = 'response'
    result.message = '请求成功但未解析到图片地址'
    result.suggestion = '请确认模型名可用（MiniMax 图片模型为 image-01），并检查提示词是否被内容审核拦截'
    return result
  }

  result.ok = true
  result.stage = 'success'
  result.message = '真实生图成功，模型返回了图片'
  result.detail = {
    image_url: imageUrl,
    metadata: parsed?.metadata ?? null,
  }
  return result
}

function buildImageRequest(input: ConnectionTestInput, provider: string, model: string) {
  if (provider === 'minimax') {
    return {
      method: 'POST',
      url: joinProviderUrl(input.baseUrl, '/v1', '/image_generation'),
      body: {
        model,
        prompt: IMAGE_TEST_PROMPT,
        n: 1,
        response_format: 'url',
        prompt_optimizer: false,
        aspect_ratio: '1:1',
      },
    }
  }
  if (provider === 'gemini') {
    return {
      method: 'POST',
      url: joinProviderUrl(input.baseUrl, '/v1beta', `/models/${model}:generateContent`),
      body: { contents: [{ parts: [{ text: IMAGE_TEST_PROMPT }] }] },
    }
  }
  if (provider === 'volcengine') {
    return {
      method: 'POST',
      url: joinProviderUrl(input.baseUrl, '/api/v3', '/images/generations'),
      body: { model, prompt: IMAGE_TEST_PROMPT, size: '1024x1024' },
    }
  }
  return {
    method: 'POST',
    url: joinProviderUrl(input.baseUrl, '/v1', '/images/generations'),
    body: { model, prompt: IMAGE_TEST_PROMPT, n: 1, size: '1024x1024' },
  }
}

function extractImageUrl(parsed: any): string | null {
  const urls = parsed?.data?.image_urls
  if (Array.isArray(urls) && urls.length) return urls[0]
  const list = parsed?.data
  if (Array.isArray(list) && list.length) return list[0]?.url || null
  if (typeof parsed?.data?.url === 'string') return parsed.data.url
  const b64 = parsed?.data?.image_base64
  if (Array.isArray(b64) && b64.length) return `base64:${String(b64[0]).length} chars`
  return null
}

// ─── 视频 ────────────────────────────────────────────────────────

async function testVideo(input: ConnectionTestInput, provider: string, model: string, keyType: MiniMaxKeyType = 'unknown'): Promise<ConnectionTestResult> {
  const { method, url, body } = buildVideoRequest(input, provider, model)
  const result = baseResult(input, method, url)
  const started = nowMs()

  const resp = await fetch(url, {
    method,
    headers: bearer(input.apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const text = await resp.text()
  result.latency_ms = nowMs() - started
  result.status = resp.status
  result.reachable = true
  result.response_preview = preview(text)

  if (!resp.ok) {
    const { stage, suggestion } = classifyHttpStatus(resp.status, provider, keyType)
    result.stage = stage
    result.message = `HTTP ${resp.status} ${resp.statusText || ''}`.trim()
    result.suggestion = suggestion
    const base = parseBaseResp(safeJson(text))
    if (base.statusCode != null && base.statusCode !== 0) {
      result.provider_code = base.statusCode
      result.provider_message = base.statusMsg
      result.message = base.statusMsg || result.message
      result.suggestion = hintForCode(base.statusCode, base.statusMsg) || suggestion
    }
    return result
  }

  const parsed = safeJson(text)
  const base = parseBaseResp(parsed)
  if (base.statusCode != null && base.statusCode !== 0) {
    result.stage = 'response'
    result.provider_code = base.statusCode
    result.provider_message = base.statusMsg
    result.message = base.statusMsg || `厂商返回错误码 ${base.statusCode}`
    result.suggestion = hintForCode(base.statusCode, base.statusMsg)
    return result
  }

  const taskId = String(parsed?.task_id ?? parsed?.task?.id ?? '')
  if (!taskId) {
    result.stage = 'response'
    result.message = '请求成功但未返回 task_id'
    result.suggestion = '请确认 Base URL 指向的是视频生成端点（MiniMax: /v1/video_generation 或 /v2/video_generation）'
    return result
  }

  result.ok = true
  result.stage = 'success'
  result.message = '真实提交成功：上游已接受任务'
  result.detail = { task_id: taskId, submitted: true }

  // 短轮询：拿到 Success / Fail 就返回，拿到中间态则如实告知仍在生成
  const pollResult = await pollVideoTask(input, provider, model, taskId)
  if (pollResult) {
    result.detail = { ...result.detail, ...pollResult.detail }
    result.message = pollResult.message
    result.provider_code = pollResult.provider_code
    result.provider_message = pollResult.provider_message
    if (!pollResult.ok) {
      result.stage = pollResult.stage
      result.suggestion = pollResult.suggestion
    }
  }
  return result
}

function buildVideoRequest(input: ConnectionTestInput, provider: string, model: string) {
  if (provider === 'minimax') {
    const isH3 = /^minimax-h3/i.test(model)
    if (isH3) {
      // 真实测试也必须用该模型**支持**的分辨率/时长，否则会被上游 400
      const profile = getH3Profile(model)
      const resolution = profile?.defaultResolution ?? '768P'
      const duration = profile?.defaultDuration ?? 5
      return {
        method: 'POST',
        url: joinProviderUrl(input.baseUrl, '/v2', '/video_generation'),
        body: {
          model,
          content: [{ type: 'text', text: VIDEO_TEST_PROMPT }],
          duration,
          resolution,
          ratio: '16:9',
        },
      }
    }
    const profile = getClassicVideoProfile(model)
    const resolution = profile?.defaultResolution ?? '720P'
    const duration = profile?.defaultDuration ?? 6
    return {
      method: 'POST',
      url: joinProviderUrl(input.baseUrl, '/v1', '/video_generation'),
      body: {
        model,
        prompt: VIDEO_TEST_PROMPT,
        duration,
        resolution,
        prompt_optimizer: false,
      },
    }
  }
  if (provider === 'volcengine') {
    return {
      method: 'POST',
      url: joinProviderUrl(input.baseUrl, '/api/v3', '/contents/generations/tasks'),
      body: { model, content: [{ type: 'text', text: VIDEO_TEST_PROMPT }] },
    }
  }
  if (provider === 'aliyun') {
    return {
      method: 'POST',
      url: joinProviderUrl(input.baseUrl, '/api/v1', '/services/aigc/video-generation/video-synthesis'),
      body: { model, input: { prompt: VIDEO_TEST_PROMPT }, parameters: {} },
    }
  }
  return {
    method: 'POST',
    url: joinProviderUrl(input.baseUrl, '/v1', '/videos'),
    body: { model, prompt: VIDEO_TEST_PROMPT },
  }
}

async function pollVideoTask(
  input: ConnectionTestInput,
  provider: string,
  model: string,
  taskId: string,
): Promise<ConnectionTestResult | null> {
  if (provider !== 'minimax') return null

  const isH3 = /^minimax-h3/i.test(model)
  const pollUrl = isH3
    ? joinProviderUrl(input.baseUrl, '/v2', `/query/video_generation/${taskId}`)
    : joinProviderUrl(input.baseUrl, '/v1', `/query/video_generation?task_id=${encodeURIComponent(taskId)}`)

  const deadline = nowMs() + (input.pollTimeoutMs ?? 90_000)
  const out = baseResult(input, 'GET', pollUrl)
  out.detail = { task_id: taskId }

  while (nowMs() < deadline) {
    await new Promise(r => setTimeout(r, 5000))
    try {
      const resp = await fetch(pollUrl, {
        method: 'GET',
        headers: bearer(input.apiKey, false),
        signal: AbortSignal.timeout(30_000),
      })
      const text = await resp.text()
      if (!resp.ok) {
        out.stage = 'poll'
        out.message = `查询任务失败 HTTP ${resp.status}`
        out.suggestion = '任务已提交但查询失败，请到厂商控制台确认任务状态'
        out.response_preview = preview(text)
        return out
      }
      const parsed = safeJson(text)
      const base = parseBaseResp(parsed)
      if (base.statusCode != null && base.statusCode !== 0) {
        out.stage = 'poll'
        out.provider_code = base.statusCode
        out.provider_message = base.statusMsg
        out.message = base.statusMsg || '查询任务返回错误'
        out.suggestion = hintForCode(base.statusCode, base.statusMsg)
        return out
      }
      const task = parsed?.task && typeof parsed.task === 'object' ? parsed.task : parsed
      const status = String(task?.status ?? parsed?.status ?? '')
      if (status === 'Success' || status === 'succeeded') {
        out.ok = true
        out.stage = 'success'
        out.message = '真实提交并生成成功，视频已产出'
        out.detail = { task_id: taskId, task_status: status, file_id: parsed?.file_id ?? null }
        return out
      }
      if (status === 'Fail' || status === 'failed') {
        out.stage = 'poll'
        const err = task?.error ?? parsed?.error
        const msg = typeof err === 'string' ? err : (err?.message || '上游任务失败')
        out.message = `上游任务失败：${msg}`
        out.suggestion = '请检查提示词是否触发内容审核，或降低任务复杂度后重试'
        out.detail = { task_id: taskId, task_status: status }
        return out
      }
      out.detail = { task_id: taskId, task_status: status || 'Processing' }
    } catch (error: any) {
      out.stage = 'poll'
      out.message = `查询任务异常：${error?.message || error}`
      out.suggestion = '任务已提交，查询暂时失败；可在厂商控制台确认任务状态'
      return out
    }
  }

  out.ok = true
  out.stage = 'success'
  out.message = '真实提交成功：上游已接受任务（轮询时间内尚未渲染完成）'
  out.suggestion = '视频仍在生成中，属于正常情况；该任务号可在厂商控制台查看'
  return out
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 供路由层复用的日志包装 */
export function logTestResult(result: ConnectionTestResult) {
  const meta = {
    provider: result.provider,
    serviceType: result.service_type,
    model: result.model,
    status: result.status,
    latency_ms: result.latency_ms,
    stage: result.stage,
  }
  if (result.ok) logTaskSuccess('AIConfig', 'connection-test-ok', meta)
  else logTaskError('AIConfig', 'connection-test-failed', { ...meta, message: result.message })
}
