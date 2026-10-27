import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, notFound, created, badRequest, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { joinProviderUrl } from '../services/adapters/url.js'
import { isOfficialProvider, parseConfigTemperature } from '../services/ai.js'
import { logTestResult, runConnectionTest } from '../services/ai-connection-test.js'
import { fetchMiniMaxPlanQuota } from '../services/adapters/minimax-plan.js'
import { hintForCode, parseBaseResp } from '../services/adapters/minimax-common.js'
import { redactUrl, logTaskProgress } from '../utils/task-logger.js'

const app = new Hono()

/** 归一化 temperature 入参：null=未设置；合法值 0~2；非法抛错 */
function normalizeTemperature(v: any): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 2) throw new Error('invalid temperature')
  return n
}

/** 把 settings JSON 中的 temperature 透出为顶层字段，便于前端直接读写 */
function withParsedFields(r: any) {
  return {
    ...toSnakeCase(r),
    model: r.model ? JSON.parse(r.model) : [],
    temperature: parseConfigTemperature(r.settings),
  }
}

function bearerHeaders(apiKey?: string, withJson = false) {
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

function geminiHeaders(apiKey?: string, withJson = false) {
  const headers: Record<string, string> = {}
  if (apiKey) {
    headers['x-goog-api-key'] = apiKey
  }
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

/**
 * 轻量探针 —— 只验证「端点可达 + 鉴权是否被拒」，不产生任何计费任务。
 * 供 mode='light' 使用：用户不想为了验证配置而真实生成内容时可选。
 */
function buildProbe(serviceType: string, provider: string, baseUrl: string, model?: string, apiKey?: string) {
  const p = provider.toLowerCase()
  const m = model || ''

  if (p === 'gemini') {
    // 探针统一走 generateContent:文本运行时(AI SDK)走的就是它,官方与中转站都支持;
    // interactions 端点很多中转站未配置,探它会误报 500。
    // 用最小合法请求体而非空体——空体在部分中转站会触发上游认证失败的误报
    const modelName = m || 'gemini-3.1-pro-preview'
    const url = new URL(joinProviderUrl(baseUrl, '/v1beta', `/models/${modelName}:generateContent`))
    if (apiKey) url.searchParams.set('key', apiKey)
    return {
      method: 'POST',
      url: url.toString(),
      headers: geminiHeaders(apiKey, true),
      body: { contents: [{ parts: [{ text: 'hi' }] }] },
    }
  }

  if (p === 'openai') {
    return {
      method: 'GET',
      url: joinProviderUrl(baseUrl, '/v1', '/models'),
      headers: bearerHeaders(apiKey),
      body: undefined,
    }
  }

  if (p === 'volcengine') {
    const path = serviceType === 'video'
      ? '/contents/generations/tasks'
      : serviceType === 'text'
        ? '/chat/completions'
        : '/images/generations'
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/api/v3', path),
      headers: bearerHeaders(apiKey, true),
      body: {},
    }
  }

  if (p === 'minimax') {
    // MiniMax 文本轻量探针直接走 GET /v1/models（标准只读端点，不产生计费且不会因空参数报 400）
    if (serviceType === 'text') {
      return {
        method: 'GET',
        url: joinProviderUrl(baseUrl, '/v1', '/models'),
        headers: bearerHeaders(apiKey),
        body: undefined,
      }
    }
    // 视频按模型族分流：H3 走 v2，Hailuo 经典系列走 v1
    const isH3 = /^minimax-h3/i.test(m)
    let path = '/v1/image_generation'
    const body: Record<string, any> = {}
    if (m) body.model = m
    if (serviceType === 'video') {
      path = isH3 ? '/v2/video_generation' : '/v1/video_generation'
      if (!body.model) body.model = isH3 ? 'MiniMax-H3' : 'MiniMax-Hailuo-2.3'
    } else if (serviceType === 'image') {
      if (!body.model) body.model = 'image-01'
    }
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '', path),
      headers: bearerHeaders(apiKey, true),
      body,
    }
  }

  if (p === 'aliyun') {
    // Wan 3.0 仅支持异步提交；空请求体不会创建计费任务，仅用于验证地域端点与鉴权是否可达。
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/api/v1', '/services/aigc/video-generation/video-synthesis'),
      headers: {
        ...bearerHeaders(apiKey, true),
        'X-DashScope-Async': 'enable',
      },
      body: {},
    }
  }

  return {
    method: 'GET',
    url: joinProviderUrl(baseUrl, '', m ? `/${m}` : '/'),
    headers: bearerHeaders(apiKey),
    body: undefined,
  }
}

/** 轻量探针：只看端点是否可达、鉴权是否被拒 */
async function runLightProbe(input: {
  serviceType: string
  provider: string
  baseUrl: string
  apiKey?: string
  model?: string
}) {
  const probe = buildProbe(input.serviceType, input.provider, input.baseUrl, input.model, input.apiKey)
  const started = Date.now()
  const resp = await fetch(probe.url, {
    method: probe.method,
    headers: probe.headers,
    body: probe.body ? JSON.stringify(probe.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  const text = await resp.text()
  const reachable = [200, 204, 400, 401, 403].includes(resp.status)

  // MiniMax 把业务错误放在 base_resp 里：HTTP 200 也可能是鉴权/参数失败，
  // 不解析的话轻量探针会把「Key 无效」误报成「端点可访问」。
  const base = input.provider.toLowerCase() === 'minimax' ? parseBaseResp(safeJson(text)) : {}
  const isAuthError = base.statusCode === 1004 || base.statusCode === 2049 || [401, 403].includes(resp.status)
  const isModelPermissionError = base.statusCode === 1039

  // 当探测未传 prompt 等内容以避免扣费时，若返回 2013 或 400 缺少必填参数，
  // 证明请求已通过网关鉴权且端点畅通（如果是假 Key 会在 1004 / 401 处拦截）
  const isProbeExpectedParamError = !isAuthError && !isModelPermissionError && (
    base.statusCode === 2013 ||
    base.statusCode === 1000 ||
    base.statusCode === 1001 ||
    /missing|required|prompt|content|param/i.test(text)
  )

  const businessError = (base.statusCode != null && base.statusCode !== 0) && !isProbeExpectedParamError

  const ok = (resp.ok || isProbeExpectedParamError) && !businessError
  const stage = ok
    ? 'success'
    : isAuthError
      ? 'auth'
      : isModelPermissionError
        ? 'response'
        : reachable ? 'auth' : 'config'

  return {
    ok,
    reachable,
    service_type: input.serviceType,
    provider: input.provider,
    model: input.model || '',
    status: resp.status,
    stage,
    message: ok
      ? '端点可访问，认证与路径基本正常（轻量探测，未真实调用模型）'
      : businessError
        ? (base.statusMsg || `厂商返回错误码 ${base.statusCode}`)
        : reachable
          ? '端点已响应，请根据状态码判断认证或路径是否正确'
          : '端点未按预期响应，请检查 Base URL 和代理前缀',
    method: probe.method,
    url: redactUrl(probe.url),
    latency_ms: Date.now() - started,
    response_preview: text.slice(0, 2000),
    detail: { light: true },
    provider_code: businessError ? base.statusCode : undefined,
    provider_message: businessError ? base.statusMsg : undefined,
    suggestion: ok
      ? undefined
      : businessError
        ? (hintForCode(base.statusCode, base.statusMsg) || '可改用「真实测试」以确认模型确实可用')
        : '可改用「真实测试」以确认模型确实可用',
  }
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 轻量探针：只看端点是否可达、鉴权是否被拒；网络异常也返回结构化结果而不是 500 */
async function runLightProbeSafe(input: {
  serviceType: string
  provider: string
  baseUrl: string
  apiKey?: string
  model?: string
}) {
  try {
    return await runLightProbe(input)
  } catch (error: any) {
    return {
      ok: false,
      reachable: false,
      service_type: input.serviceType,
      provider: input.provider,
      model: input.model || '',
      status: null,
      stage: 'request',
      message: error?.message || '请求失败',
      method: '—',
      url: redactUrl(input.baseUrl),
      latency_ms: 0,
      response_preview: '',
      detail: { light: true },
      suggestion: '网络请求失败：请检查 Base URL、网络连通性与代理设置',
    }
  }
}

// GET /ai-configs?service_type=text
app.get('/', async (c) => {
  const serviceType = c.req.query('service_type')
  let rows = await db.select().from(schema.aiServiceConfigs)
  if (serviceType) rows = rows.filter(r => r.serviceType === serviceType)

  const parsed = rows.map(withParsedFields)
  return success(c, parsed)
})

// POST /ai-configs
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()

  // 验证必填字段
  if (!body.service_type || !body.provider) {
    return badRequest(c, '需要 service_type 与 provider')
  }
  if (!isOfficialProvider(body.service_type, body.provider)) {
    return badRequest(c, '不支持的 service_type/provider')
  }

  let temperature: number | null = null
  if ('temperature' in body) {
    try {
      temperature = normalizeTemperature(body.temperature)
    } catch {
      return badRequest(c, 'temperature 须为 0 到 2 之间的数字')
    }
  }

  const res = await db.insert(schema.aiServiceConfigs).values({
    serviceType: body.service_type,
    provider: body.provider,
    name: body.name || `${body.provider}-${body.service_type}`,
    baseUrl: body.base_url || '',
    apiKey: body.api_key || '',
    model: JSON.stringify(body.model || []),
    priority: body.priority || 0,
    isActive: true,
    settings: temperature !== null ? JSON.stringify({ temperature }) : null,
    createdAt: ts,
    updatedAt: ts,
  })

  const [row] = await db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, getInsertId(res)))

  return created(c, withParsedFields(row))
})

// POST /ai-configs/test
// 真实连通性测试：实际调用一次模型（文本发最小对话、图片真出一张、视频真提交一单），
// 返回成功结论 / 失败环节 / 厂商错误码 / 原始响应 / 可操作建议。
app.post('/test', async (c) => {
  const body = await c.req.json()
  if (!body.service_type || !body.provider || !body.base_url) {
    return badRequest(c, '需要 service_type、provider 与 base_url')
  }
  if (!isOfficialProvider(body.service_type, body.provider)) {
    return badRequest(c, '不支持的 service_type/provider')
  }

  const model = Array.isArray(body.model) ? body.model[0] : body.model
  // mode='light'：只探测端点可达性，不真实调用模型（不产生计费）
  const light = body.mode === 'light'

  logTaskProgress('AIConfig', light ? 'probe-start' : 'test-start', {
    serviceType: body.service_type,
    provider: body.provider,
    model: model || '',
    baseUrl: redactUrl(body.base_url),
  })

  const result = light
    ? await runLightProbeSafe({
        serviceType: body.service_type,
        provider: body.provider,
        baseUrl: body.base_url,
        apiKey: body.api_key,
        model,
      })
    : await runConnectionTest({
        serviceType: body.service_type,
        provider: body.provider,
        baseUrl: body.base_url,
        apiKey: body.api_key,
        model,
      })

  logTestResult(result as any)
  return success(c, result)
})

// POST /ai-configs/plan-quota
// 查询 MiniMax 订阅套餐（Token Plan / M Plan）剩余额度。
// 订阅 Key（sk-cp 开头）才有套餐额度；用按量 Key 调会得到 1004/401，
// 这一点本身就是有价值的诊断信息（说明 Key 类型填错了）。
app.post('/plan-quota', async (c) => {
  const body = await c.req.json()
  if (String(body.provider || '').toLowerCase() !== 'minimax') {
    return badRequest(c, '仅 MiniMax 支持订阅额度查询')
  }
  const baseUrl = String(body.base_url || '').trim()
  const apiKey = String(body.api_key || '').trim()
  if (!baseUrl) return badRequest(c, '需要 base_url')
  if (!apiKey) return badRequest(c, '需要 api_key')

  logTaskProgress('AIConfig', 'plan-quota-start', { baseUrl: redactUrl(baseUrl) })
  const quota = await fetchMiniMaxPlanQuota(baseUrl, apiKey)
  logTaskProgress('AIConfig', 'plan-quota-done', { ok: quota.ok, keyType: quota.keyType })
  return success(c, quota)
})

// GET /ai-configs/:id
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  if (!row) return notFound(c)
  return success(c, withParsedFields(row))
})

// PUT /ai-configs/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [existing] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  if (!existing) return notFound(c)

  const serviceType = 'service_type' in body ? body.service_type : existing.serviceType
  const provider = 'provider' in body ? body.provider : existing.provider
  if (!isOfficialProvider(serviceType, provider)) {
    return badRequest(c, '不支持的 service_type/provider')
  }

  const updates: Record<string, any> = { updatedAt: now() }

  if ('service_type' in body) updates.serviceType = body.service_type
  if ('provider' in body) updates.provider = body.provider
  if ('name' in body) updates.name = body.name
  if ('base_url' in body) updates.baseUrl = body.base_url
  if ('api_key' in body) updates.apiKey = body.api_key
  if ('model' in body) updates.model = JSON.stringify(body.model)
  if ('priority' in body) updates.priority = body.priority
  if ('is_active' in body) updates.isActive = body.is_active
  if ('temperature' in body) {
    let temperature: number | null
    try {
      temperature = normalizeTemperature(body.temperature)
    } catch {
      return badRequest(c, 'temperature 须为 0 到 2 之间的数字')
    }
    // 与已有 settings 合并，清空的 temperature 从 JSON 中移除
    let settings: Record<string, any> = {}
    try { settings = existing.settings ? JSON.parse(existing.settings) : {} } catch { settings = {} }
    if (temperature === null) delete settings.temperature
    else settings.temperature = temperature
    updates.settings = Object.keys(settings).length ? JSON.stringify(settings) : null
  }

  await db.update(schema.aiServiceConfigs).set(updates).where(eq(schema.aiServiceConfigs.id, id))
  return success(c)
})

// DELETE /ai-configs/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  return success(c)
})

// GET /ai-providers
export const aiProviders = new Hono()
aiProviders.get('/', async (c) => {
  const rows = await db.select().from(schema.aiServiceProviders)
  const parsed = rows.map(r => ({
    ...toSnakeCase(r),
    preset_models: r.presetModels ? JSON.parse(r.presetModels) : [],
  }))
  return success(c, parsed)
})

export default app
