/**
 * MiniMax 订阅计划（Token Plan / M Plan）接入
 *
 * ## 背景
 *
 * MiniMax 开放平台有**两种互斥的计费凭证**：
 *
 * | Key 类型      | 前缀    | 扣费来源                          | 适用端点 |
 * |---------------|---------|-----------------------------------|----------|
 * | 按量计费 API Key | `sk-api` | 账户余额                          | 全部模型 |
 * | 订阅 Key        | `sk-cp`  | 订阅套餐额度 → 积分包（**不扣余额**） | 套餐覆盖的模型 |
 *
 * 两类 Key 都用 `Authorization: Bearer <key>` 走同一批端点，**请求格式完全一致**，
 * 所以接入侧不需要为订阅 Key 改任何请求体 —— 只需要在**失败诊断**上区分，
 * 否则用户会看到误导性的「余额不足，请充值」，而真实情况是「套餐额度窗口用尽，等窗口刷新即可」。
 *
 * ## 额度窗口
 *
 * - 文本 / 图片 / 语音等非视频模型：受 **5 小时窗口** 与 **周窗口** 双重约束
 * - 视频模型：**只受周窗口约束**（等 5 小时刷新不会恢复视频额度）
 * - 两个窗口各自独立刷新，互不影响；额度不结转到下个周期
 *
 * ## 覆盖范围（会变，以官方控制台为准）
 *
 * - M Plan 的 Go 档**不含视频模型**；Explore / Build 含 H3
 * - 旧版 Token Plan **不含 MiniMax-H3**；H3 的 v2 接口需要按量付费（或 M Plan Explore/Build）
 * - **视频资源包只覆盖 Hailuo 系列，不覆盖 H3**
 *
 * ## 额度查询
 *
 * 官方文档给出 `GET /v1/token_plan/remains`（需订阅 Key），老路径为 `/v1/coding_plan/remains`。
 * 两个端点在国内站 / 国际站都可用，返回体结构略有差异，本模块统一归一化。
 */
import { joinProviderUrl } from './url'
import { parseBaseResp } from './minimax-common'

/** 凭证类型 */
export type MiniMaxKeyType = 'subscription' | 'payg' | 'unknown'

/**
 * 根据 Key 前缀判断计费类型。
 * MiniMax 开放平台签发的 Key：`sk-api...` = 按量计费，`sk-cp...` = 订阅套餐。
 * 前缀不匹配时返回 unknown（可能是自建网关的代理 Key），不做任何假设。
 */
export function detectMiniMaxKeyType(apiKey?: string | null): MiniMaxKeyType {
  const key = String(apiKey || '').trim()
  if (!key) return 'unknown'
  if (/^sk-cp/i.test(key)) return 'subscription'
  if (/^sk-api/i.test(key)) return 'payg'
  return 'unknown'
}

/** 订阅 Key 的人类可读说明 */
export function describeKeyType(type: MiniMaxKeyType): string {
  if (type === 'subscription') return '订阅 Key（套餐计费，sk-cp 开头）'
  if (type === 'payg') return '按量计费 API Key（sk-api 开头，扣账户余额）'
  return '未知类型 Key'
}

// ─── 额度查询 ──────────────────────────────────────────────────────

/** 单个额度窗口（5 小时窗口 / 周窗口） */
export interface MiniMaxPlanWindow {
  total: number
  used: number
  remaining: number
  /** 剩余百分比（0~100），无法计算时为 null */
  percentRemaining: number | null
  /** 窗口下次重置时间（上游若返回） */
  resetTime?: string
}

export interface MiniMaxPlanModelQuota {
  model: string
  remaining: number | null
  total: number | null
  percentRemaining: number | null
}

export interface MiniMaxPlanQuota {
  ok: boolean
  keyType: MiniMaxKeyType
  /** 套餐名（若上游返回） */
  plan?: string | null
  /** 5 小时滚动窗口（非视频模型） */
  interval: MiniMaxPlanWindow | null
  /** 周窗口（所有模型） */
  weekly: MiniMaxPlanWindow | null
  /** 按模型拆分的额度 */
  models: MiniMaxPlanModelQuota[]
  /** 实际命中的查询端点 */
  endpoint?: string
  message: string
  suggestion?: string
  providerCode?: number
  providerMessage?: string
  raw?: unknown
}

/** 额度查询端点候选（同一台服务器的不同路径） */
const QUOTA_PATHS = ['/v1/token_plan/remains', '/v1/coding_plan/remains']

/**
 * 构造候选查询地址。
 * 官方 FAQ 给的是 `https://www.minimax.cn/v1/token_plan/remains`，
 * 而实际 API host（api.minimaxi.com / api.minimax.io）同样提供该路径，
 * 因此这里以用户配置的 Base URL 为主，并补一个 www 主机兜底。
 */
export function buildQuotaUrls(baseUrl: string): string[] {
  const urls: string[] = []
  const base = (baseUrl || '').trim()
  for (const p of QUOTA_PATHS) {
    if (base) urls.push(joinProviderUrl(base, '', p))
  }
  // www 主机兜底（仅当用户填的是 api.* 主机时才需要）
  for (const p of QUOTA_PATHS) {
    try {
      const u = new URL(base || 'https://api.minimaxi.com')
      if (u.hostname.startsWith('api.')) {
        u.hostname = u.hostname.replace(/^api\./, 'www.')
        urls.push(`${u.origin}${p}`)
      }
    } catch {
      /* base 非法则忽略兜底 */
    }
  }
  return Array.from(new Set(urls))
}

function num(v: any): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function pickWindow(
  source: any,
  totalKeys: string[],
  usedKeys: string[],
  resetKeys: string[],
): MiniMaxPlanWindow | null {
  let total: number | null = null
  let used: number | null = null
  for (const k of totalKeys) {
    const v = num(source?.[k])
    if (v != null) { total = v; break }
  }
  for (const k of usedKeys) {
    const v = num(source?.[k])
    if (v != null) { used = v; break }
  }
  if (total == null && used == null) return null
  const t = total ?? 0
  const u = used ?? 0
  let percent: number | null = null
  if (t > 0) percent = Math.max(0, Math.min(100, Math.round(((t - u) / t) * 100)))
  let resetTime: string | undefined
  for (const k of resetKeys) {
    if (typeof source?.[k] === 'string' && source[k]) { resetTime = source[k]; break }
  }
  return { total: t, used: u, remaining: Math.max(0, t - u), percentRemaining: percent, resetTime }
}

function normalizeModelRemains(list: any): MiniMaxPlanModelQuota[] {
  if (!Array.isArray(list)) return []
  const out: MiniMaxPlanModelQuota[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const name = String(item.model ?? item.model_name ?? item.name ?? '').trim()
    if (!name) continue
    const total = num(item.total ?? item.current_interval_total_count ?? item.current_weekly_total_count)
    let remaining = num(item.remains ?? item.remaining)
    const used = num(item.current_interval_usage_count ?? item.current_weekly_usage_count)
    let percent = num(item.interval_remaining_percent ?? item.remaining_percent)
    if (percent == null && remaining != null && total != null && total > 0) {
      percent = Math.max(0, Math.min(100, Math.round((remaining / total) * 100)))
    }
    if (percent != null && percent > 100) percent = 100
    if (percent != null && percent < 0) percent = 0
    if (remaining == null && total != null && used != null) remaining = Math.max(0, total - used)
    out.push({ model: name, remaining, total, percentRemaining: percent })
  }
  return out
}

/** 从上游响应体里抽出额度数据（兼容顶层 / data 包裹 / 多种字段名） */
export function parsePlanQuota(payload: any): {
  interval: MiniMaxPlanWindow | null
  weekly: MiniMaxPlanWindow | null
  models: MiniMaxPlanModelQuota[]
  plan?: string | null
} {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload
  const interval = pickWindow(
    data,
    ['current_interval_total_count', 'interval_total_count', 'current_total_count'],
    ['current_interval_usage_count', 'interval_usage_count', 'current_usage_count'],
    ['current_interval_reset_time', 'interval_reset_time', 'reset_time'],
  )
  const weekly = pickWindow(
    data,
    ['current_weekly_total_count', 'weekly_total_count'],
    ['current_weekly_usage_count', 'weekly_usage_count'],
    ['current_weekly_reset_time', 'weekly_reset_time'],
  )
  const models = normalizeModelRemains(
    data?.model_remains ?? data?.modelRemains ?? payload?.model_remains ?? payload?.modelRemains,
  )
  const plan = typeof data?.plan === 'string' ? data.plan
    : typeof data?.plan_name === 'string' ? data.plan_name
    : typeof payload?.plan === 'string' ? payload.plan
    : null
  return { interval, weekly, models, plan }
}

/**
 * 查询 MiniMax 订阅额度。
 *
 * 只对**订阅 Key** 有意义：用按量计费 Key 调用会得到 1004/401，
 * 这本身也是有价值的诊断信息（说明填错 Key 类型了）。
 */
export async function fetchMiniMaxPlanQuota(
  baseUrl: string,
  apiKey: string,
  opts: { timeoutMs?: number } = {},
): Promise<MiniMaxPlanQuota> {
  const keyType = detectMiniMaxKeyType(apiKey)
  const result: MiniMaxPlanQuota = {
    ok: false,
    keyType,
    interval: null,
    weekly: null,
    models: [],
    message: '',
  }

  if (!apiKey) {
    result.message = '缺少 API Key'
    result.suggestion = '请填写订阅 Key 后再查询额度'
    return result
  }

  const urls = buildQuotaUrls(baseUrl)
  if (!urls.length) {
    result.message = '缺少 Base URL'
    result.suggestion = '请先填写 MiniMax API 地址（国内站 https://api.minimaxi.com）'
    return result
  }

  let lastError: any = null
  for (const url of urls) {
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      })
      const text = await resp.text()
      let parsed: any = null
      try { parsed = JSON.parse(text) } catch { parsed = null }

      if (!resp.ok) {
        lastError = { url, status: resp.status, body: parsed ?? text.slice(0, 500) }
        continue
      }

      const base = parseBaseResp(parsed)
      if (base.statusCode != null && base.statusCode !== 0) {
        lastError = { url, status: resp.status, code: base.statusCode, msg: base.statusMsg, body: parsed }
        continue
      }

      const quota = parsePlanQuota(parsed)
      result.ok = true
      result.endpoint = url
      result.interval = quota.interval
      result.weekly = quota.weekly
      result.models = quota.models
      result.plan = quota.plan
      result.raw = parsed
      result.message = summarizeQuota(quota)
      return result
    } catch (error: any) {
      lastError = { url, error: error?.message || String(error) }
    }
  }

  // 全部候选路径都失败：挑信息量最大的那个报错
  const code = lastError?.code
  result.providerCode = typeof code === 'number' ? code : undefined
  result.providerMessage = lastError?.msg || lastError?.error
  result.message = lastError?.msg
    || (lastError?.status ? `额度查询失败 HTTP ${lastError.status}` : '额度查询失败')
  result.suggestion = planQuotaSuggestion(code, lastError?.status, keyType)
  return result
}

function summarizeQuota(quota: ReturnType<typeof parsePlanQuota>): string {
  const parts: string[] = []
  if (quota.interval) {
    parts.push(
      `5 小时窗口 ${quota.interval.remaining}/${quota.interval.total}` +
      (quota.interval.percentRemaining != null ? `（剩余 ${quota.interval.percentRemaining}%）` : ''),
    )
  }
  if (quota.weekly) {
    parts.push(
      `周窗口 ${quota.weekly.remaining}/${quota.weekly.total}` +
      (quota.weekly.percentRemaining != null ? `（剩余 ${quota.weekly.percentRemaining}%）` : ''),
    )
  }
  if (!parts.length && quota.models.length) {
    parts.push(`已返回 ${quota.models.length} 个模型的额度明细`)
  }
  return parts.length ? parts.join(' · ') : '额度查询成功，但上游未返回窗口数据'
}

/** 额度查询失败时的可操作建议 */
export function planQuotaSuggestion(code?: number, httpStatus?: number, keyType: MiniMaxKeyType = 'unknown'): string {
  if (code === 1004 || httpStatus === 401 || httpStatus === 403) {
    return keyType === 'payg'
      ? '该 Key 是按量计费 API Key（sk-api 开头），不能查询订阅额度。请到「订阅管理」复制订阅 Key（sk-cp 开头）。'
      : '订阅 Key 无效或未绑定有效套餐：请到 MiniMax 开放平台「订阅管理」确认套餐已生效，并确认 Key 与账号区域一致（国内 api.minimaxi.com / 国际 api.minimax.io）。'
  }
  if (code === 2062) {
    return '当前账号没有生效的订阅计划（no active token plan）。如需使用订阅额度请先订阅 Token Plan / M Plan。'
  }
  if (code === 2056) {
    return '订阅额度窗口已用尽：请等待窗口重置，或购买积分包，或改用按量计费 API Key。'
  }
  if (httpStatus === 404) {
    return '未找到额度查询端点：请确认 Base URL 指向 MiniMax 官方地址，且该 Key 属于订阅 Key。'
  }
  return '请检查 Base URL、网络连通性，以及 Key 是否为订阅 Key（sk-cp 开头）。'
}

// ─── 套餐覆盖范围 ─────────────────────────────────────────────────

/**
 * 模型是否在订阅套餐的覆盖范围内。
 *
 * 依据官方说明（会随套餐调整，以控制台为准）：
 * - M Plan Go 不含视频模型；Explore / Build 含 H3
 * - 旧版 Token Plan 不含 H3
 * - 视频资源包只覆盖 Hailuo 系列
 */
export function isModelCoveredByPlan(model: string | null | undefined): boolean | null {
  const m = String(model || '').trim()
  if (!m) return null
  if (/^minimax-h3/i.test(m)) return false // 需 M Plan Explore/Build 或按量付费
  if (/hailuo|^t2v|^i2v|^s2v|^video-01/i.test(m)) return true
  if (/^image-01/i.test(m)) return true
  if (/^minimax-m[0-9]/i.test(m) || /^minimax-m2/i.test(m)) return true
  return null
}

/** 针对「订阅 Key + 不在套餐内模型」的提示 */
export function planCoverageHint(model: string | null | undefined): string | undefined {
  const m = String(model || '').trim()
  if (!m) return undefined
  if (/^minimax-h3/i.test(m)) {
    return `${m} 不在旧版 Token Plan 覆盖范围内：H3 的 v2 接口需要按量付费 API Key（sk-api），或使用包含视频模型的 M Plan Explore / Build 档位。另注意「视频资源包」只覆盖 Hailuo 系列，不覆盖 H3。`
  }
  return undefined
}

/**
 * 依据 Key 类型 + 错误码，给出「额度」维度的精确诊断。
 * 返回 null 表示该错误与计费无关。
 */
export function planBillingHint(
  code: number | undefined,
  statusMsg: string | undefined,
  keyType: MiniMaxKeyType,
): string | undefined {
  if (code === 2056) {
    return '订阅额度窗口已用尽（Token Plan usage window exceeded）：文本/图片/语音受 5 小时窗口与周窗口约束，视频只受周窗口约束。可选：等待窗口重置、购买积分包，或改用按量计费 API Key。'
  }
  if (code === 2062) {
    return '当前 Key 没有生效的订阅计划（no active token plan）：请确认已订阅 Token Plan / M Plan 且套餐在有效期内。'
  }
  if (code === 1008) {
    if (keyType === 'subscription') {
      return '订阅额度已用尽且无积分包可用：请等待额度窗口重置、购买积分包，或改用按量计费 API Key（sk-api）。'
    }
    if (keyType === 'payg') {
      return '账户余额不足：请前往 MiniMax 开放平台「财务管理」充值。注意使用订阅 Key（sk-cp 开头）走套餐额度不会扣账户余额。'
    }
    return '余额或额度不足：请确认 Key 类型（sk-api 按量扣余额 / sk-cp 走套餐额度），并检查账户余额与套餐状态。'
  }
  if (code === 1004) {
    if (keyType === 'subscription') {
      return '鉴权失败：订阅 Key 无效或与账号区域不匹配。请确认 Key 来自开放平台「订阅管理」，且区域一致（国内 api.minimaxi.com / 国际 api.minimax.io 不可混用）。'
    }
    return '鉴权失败：按量计费 API Key 无效、已过期或未开通该模型权限。请在开放平台「接口密钥」确认 Key，并核对区域（国内 api.minimaxi.com / 国际 api.minimax.io）。'
  }
  if (statusMsg && /no active token plan/i.test(statusMsg)) {
    return '当前 Key 没有生效的订阅计划（no active token plan）。'
  }
  return undefined
}
