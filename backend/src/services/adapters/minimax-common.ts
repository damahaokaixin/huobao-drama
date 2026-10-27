/**
 * MiniMax 公共工具 — base_resp 解析 / 模型族识别 / 模型能力档案 / 端点拼装
 *
 * MiniMax 所有接口都把业务错误放在响应体的 base_resp 里：
 *   { base_resp: { status_code: 0, status_msg: 'success' } }
 * HTTP 200 不代表成功，必须以 status_code 是否为 0 判定。
 * 常见错误码：
 *   1000 参数错误 / 1002 限流 / 1004 鉴权失败 / 1008 余额或额度不足
 *   1026 内容审核拦截 / 1039 模型不存在或无权限
 *   2056 订阅额度窗口用尽 / 2062 无生效订阅计划
 */
import { ProviderError } from './errors'

export interface MiniMaxBaseResp {
  statusCode?: number
  statusMsg?: string
}

export function parseBaseResp(result: any): MiniMaxBaseResp {
  const base = result?.base_resp
  if (!base || typeof base !== 'object') return {}
  return {
    statusCode: typeof base.status_code === 'number' ? base.status_code : undefined,
    statusMsg: typeof base.status_msg === 'string' ? base.status_msg : undefined,
  }
}

/** 错误码 → 中文可操作提示 */
const CODE_HINTS: Record<number, string> = {
  1000: '请求参数有误，请检查模型名、提示词长度与必填字段',
  1001: '请求体缺少必填参数',
  1002: '触发 MiniMax 频率限制，请降低并发或稍后重试',
  1004: '鉴权失败：API Key 无效、已过期或未开通该模型权限',
  1008: '账户余额不足，请前往 MiniMax 开放平台充值',
  1010: '请求参数格式错误',
  1026: '内容被安全审核拦截，请调整提示词后重试',
  1027: '内容审核未通过',
  1039: '模型不存在或当前账号无权限使用该模型，请在开放平台「模型广场」确认已开通',
  2013: '输入参数非法',
  1029: '音频或视频文件格式不受支持',
  2049: '鉴权失败：Key 无效或与账号区域不匹配（国内 api.minimaxi.com / 国际 api.minimax.io 不可混用）',
  2056: '订阅额度窗口已用尽（Token Plan usage window exceeded），请等待窗口重置、购买积分包或改用按量计费 Key',
  2062: '当前 Key 没有生效的订阅计划（no active token plan）',
}

export function hintForCode(statusCode?: number, statusMsg?: string): string | undefined {
  if (statusCode != null && CODE_HINTS[statusCode]) return CODE_HINTS[statusCode]
  if (statusMsg) {
    if (/no active token plan/i.test(statusMsg)) return CODE_HINTS[2062]
    if (/window|quota|usage limit/i.test(statusMsg)) return CODE_HINTS[2056]
    if (/balance|insufficient/i.test(statusMsg)) return CODE_HINTS[1008]
    if (/rate|limit|too many/i.test(statusMsg)) return CODE_HINTS[1002]
    if (/auth|api_?key|permission/i.test(statusMsg)) return CODE_HINTS[1004]
    if (/moderation|sensitive|content/i.test(statusMsg)) return CODE_HINTS[1026]
    if (/model/i.test(statusMsg)) return CODE_HINTS[1039]
  }
  return undefined
}

/**
 * 校验 base_resp，失败则抛出带完整详情的 ProviderError
 * @param result 上游响应体
 * @param ctx 上下文（请求 URL / 请求体），用于失败详情
 */
export function assertMiniMaxOk(
  result: any,
  ctx: { stage?: 'response' | 'poll' | 'download'; requestUrl?: string; requestBody?: unknown; httpStatus?: number } = {},
): void {
  const { statusCode, statusMsg } = parseBaseResp(result)
  if (statusCode == null || statusCode === 0) return
  const message = statusMsg?.trim() || `MiniMax 返回错误码 ${statusCode}`
  throw new ProviderError({
    stage: ctx.stage ?? 'response',
    message,
    httpStatus: ctx.httpStatus,
    providerCode: statusCode,
    providerMessage: statusMsg,
    requestUrl: ctx.requestUrl,
    requestBody: ctx.requestBody,
    responseBody: result,
    hint: hintForCode(statusCode, statusMsg),
  })
}

// ─── 模型族识别 ────────────────────────────────────────────────────

/** H3 系列（v2 接口）：minimax-h3 / MiniMax-H3 / MiniMax-H3-Max … */
export function isH3Model(model: string | null | undefined): boolean {
  return /^minimax-h3/i.test(String(model || '').trim())
}

/** 经典视频模型（v1 接口）：Hailuo / T2V / I2V / S2V / Video-01 */
export function isClassicVideoModel(model: string | null | undefined): boolean {
  const m = String(model || '').trim().toLowerCase()
  if (!m) return false
  if (isH3Model(m)) return false
  return /hailuo|^t2v|^i2v|^s2v|^video-01|video-01$/.test(m)
}

/** 图片模型（v1 接口）：image-01 / image-01-live */
export function isMiniMaxImageModel(model: string | null | undefined): boolean {
  return /^image-01/i.test(String(model || '').trim())
}

// ─── 模型能力档案 ──────────────────────────────────────────────────

/**
 * MiniMax 视频模型的分辨率 / 时长 / 参考素材能力。
 *
 * 官方文档里不同模型的限制差别很大，硬编码一套参数会在很多组合上直接 400，
 * 所以这里按模型给出精确档案，适配器按档案归一化参数。
 */
export interface MiniMaxVideoProfile {
  /** 模型 ID（规范化后） */
  model: string
  /** 使用的 API 版本 */
  api: 'v1' | 'v2'
  /** 官方支持的分辨率档位（降序） */
  resolutions: string[]
  /** 默认分辨率 */
  defaultResolution: string
  /** 官方支持的时长（秒，升序） */
  durations: number[]
  /** 默认时长 */
  defaultDuration: number
  /** 时长区间（连续模型按区间钳制） */
  minDuration: number
  maxDuration: number
  /** 是否支持首帧图 */
  supportsFirstFrame: boolean
  /** 首帧图是否必填 */
  requiresFirstFrame: boolean
  /** 是否支持尾帧图（首尾帧插值，仅 MiniMax-Hailuo-02 支持） */
  supportsLastFrame: boolean
  /** 是否支持多模态参考素材（图片/视频/音频） */
  supportsReference: boolean
  /** 是否支持角色参考 subject_reference */
  supportsSubjectReference: boolean
  /** 是否支持 prompt_optimizer */
  supportsPromptOptimizer: boolean
  /** 模型能力说明（用于 UI 提示） */
  note?: string
}

function profile(init: Partial<MiniMaxVideoProfile> & { model: string; api: 'v1' | 'v2' }): MiniMaxVideoProfile {
  const resolutions = init.resolutions ?? ['768P']
  const durations = init.durations ?? [6]
  return {
    model: init.model,
    api: init.api,
    resolutions,
    defaultResolution: init.defaultResolution ?? resolutions[0],
    durations,
    defaultDuration: init.defaultDuration ?? durations[0],
    minDuration: init.minDuration ?? durations[0],
    maxDuration: init.maxDuration ?? durations[durations.length - 1],
    supportsFirstFrame: init.supportsFirstFrame ?? false,
    requiresFirstFrame: init.requiresFirstFrame ?? false,
    supportsLastFrame: init.supportsLastFrame ?? false,
    supportsReference: init.supportsReference ?? false,
    supportsSubjectReference: init.supportsSubjectReference ?? false,
    supportsPromptOptimizer: init.supportsPromptOptimizer ?? true,
    note: init.note,
  }
}

/**
 * H3 家族能力档案。
 *
 * 官方口径（api-overview / pricing）：
 * - MiniMax-H3              768P / 2K，4–15s，全模态
 * - MiniMax-H3-Highspeed    仅 768P（不支持 2K），4–15s，全模态
 * - MiniMax-H3-Lite         480P / 768P（不支持 2K），4–15s，全模态
 * - MiniMax-H3-Max          480P / 768P（不支持 2K），5–15s，全模态
 * - MiniMax-H3-Max-Turbo    480P / 768P，不支持参考生与视频输入
 */
const H3_PROFILES: MiniMaxVideoProfile[] = [
  profile({
    model: 'MiniMax-H3',
    api: 'v2',
    resolutions: ['2K', '768P'],
    defaultResolution: '768P',
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    defaultDuration: 5,
    minDuration: 4,
    maxDuration: 15,
    supportsFirstFrame: true,
    supportsLastFrame: true,
    supportsReference: true,
  }),
  profile({
    model: 'MiniMax-H3-Highspeed',
    api: 'v2',
    resolutions: ['768P'],
    defaultResolution: '768P',
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    defaultDuration: 5,
    minDuration: 4,
    maxDuration: 15,
    supportsFirstFrame: true,
    supportsLastFrame: true,
    supportsReference: true,
    note: 'H3-Highspeed 不支持 2K',
  }),
  profile({
    model: 'MiniMax-H3-Lite',
    api: 'v2',
    resolutions: ['768P', '480P'],
    defaultResolution: '768P',
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    defaultDuration: 5,
    minDuration: 4,
    maxDuration: 15,
    supportsFirstFrame: true,
    supportsLastFrame: true,
    supportsReference: true,
    note: 'H3-Lite 最高 768P',
  }),
  profile({
    model: 'MiniMax-H3-Max',
    api: 'v2',
    resolutions: ['768P', '480P'],
    defaultResolution: '768P',
    durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    defaultDuration: 6,
    minDuration: 5,
    maxDuration: 15,
    supportsFirstFrame: true,
    supportsLastFrame: true,
    supportsReference: true,
    note: 'H3-Max 最短 5s、最高 768P',
  }),
  profile({
    model: 'MiniMax-H3-Max-Turbo',
    api: 'v2',
    resolutions: ['768P', '480P'],
    defaultResolution: '768P',
    durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    defaultDuration: 6,
    minDuration: 5,
    maxDuration: 15,
    supportsFirstFrame: true,
    supportsLastFrame: true,
    supportsReference: false,
    note: 'H3-Max-Turbo 不支持参考生与视频输入',
  }),
]

/**
 * 经典（v1）视频模型能力档案。
 *
 * 官方口径（video-generation v1 / models-intro / pricing）：
 * - MiniMax-Hailuo-2.3         文生+图生，768P/1080P，6s（1080P）/ 6s、10s（768P）
 * - MiniMax-Hailuo-2.3-Fast    仅图生（首帧必填），768P/1080P，同上
 * - MiniMax-Hailuo-02          文生+图生+首尾帧，512P/768P/1080P，6s、10s（512P/768P）
 * - T2V/I2V/S2V/Video-01       720P，6s
 */
const CLASSIC_PROFILES: MiniMaxVideoProfile[] = [
  profile({
    model: 'MiniMax-Hailuo-2.3',
    api: 'v1',
    resolutions: ['1080P', '768P'],
    defaultResolution: '768P',
    durations: [6, 10],
    defaultDuration: 6,
    supportsFirstFrame: true,
    note: 'Hailuo-2.3 支持文生与图生；10s 仅 768P',
  }),
  profile({
    model: 'MiniMax-Hailuo-2.3-Fast',
    api: 'v1',
    resolutions: ['1080P', '768P'],
    defaultResolution: '768P',
    durations: [6, 10],
    defaultDuration: 6,
    supportsFirstFrame: true,
    requiresFirstFrame: true,
    note: 'Hailuo-2.3-Fast 仅支持图生视频（首帧图必填）',
  }),
  profile({
    model: 'MiniMax-Hailuo-02',
    api: 'v1',
    resolutions: ['1080P', '768P', '512P'],
    defaultResolution: '768P',
    durations: [6, 10],
    defaultDuration: 6,
    supportsFirstFrame: true,
    supportsLastFrame: true,
    note: 'Hailuo-02 支持首尾帧插值；10s 仅 512P/768P',
  }),
]

/** 720P / 6s 的老一代模型（Director / 01 系列 / Video-01） */
const CLASSIC_LEGACY_PROFILES: Record<string, Partial<MiniMaxVideoProfile>> = {
  't2v-01-director': { supportsFirstFrame: false, supportsPromptOptimizer: true },
  't2v-01': { supportsFirstFrame: false },
  'i2v-01-director': { supportsFirstFrame: true, requiresFirstFrame: true },
  'i2v-01-live': { supportsFirstFrame: true, requiresFirstFrame: true },
  'i2v-01': { supportsFirstFrame: true, requiresFirstFrame: true },
  's2v-01': { supportsFirstFrame: false, supportsSubjectReference: true },
  'video-01': { supportsFirstFrame: true },
}

/** 规范模型 ID（去掉厂商前缀差异，统一大小写形态） */
export function normalizeMiniMaxModelId(model: string): string {
  const raw = String(model || '').trim()
  if (!raw) return ''
  // 保留官方大小写：只有前缀做小写比较
  return raw
}

/** 取 H3 家族档案 */
export function getH3Profile(model: string | null | undefined): MiniMaxVideoProfile | null {
  const m = String(model || '').trim()
  if (!m) return null
  const lower = m.toLowerCase()
  // 精确匹配优先（先匹配更长的名字，避免 H3 命中 H3-Max）
  const sorted = [...H3_PROFILES].sort((a, b) => b.model.length - a.model.length)
  for (const p of sorted) {
    if (lower === p.model.toLowerCase()) return p
  }
  for (const p of sorted) {
    if (lower.startsWith(p.model.toLowerCase())) return p
  }
  // 未知 H3 变体：按最宽松的 H3 处理，但限制 2K（未知模型不一定支持）
  if (isH3Model(m)) {
    return profile({
      model: m,
      api: 'v2',
      resolutions: ['768P'],
      defaultResolution: '768P',
      durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      defaultDuration: 5,
      minDuration: 4,
      maxDuration: 15,
      supportsFirstFrame: true,
      supportsLastFrame: true,
      supportsReference: true,
      note: '未识别的 H3 变体，已按最保守参数（768P / 4–15s）处理',
    })
  }
  return null
}

/** 取经典（v1）视频模型档案 */
export function getClassicVideoProfile(model: string | null | undefined): MiniMaxVideoProfile | null {
  const m = String(model || '').trim()
  if (!m) return null
  const lower = m.toLowerCase()
  for (const p of CLASSIC_PROFILES) {
    if (lower === p.model.toLowerCase()) return p
  }
  // 前缀匹配时取最长命中，避免 'Hailuo-2.3-Fast' 被 'Hailuo-2.3' 抢先匹配
  const sorted = [...CLASSIC_PROFILES].sort((a, b) => b.model.length - a.model.length)
  for (const p of sorted) {
    if (lower.startsWith(p.model.toLowerCase())) return p
  }
  for (const [key, extra] of Object.entries(CLASSIC_LEGACY_PROFILES)) {
    if (lower === key || lower.startsWith(key)) {
      return profile({
        model: m,
        api: 'v1',
        resolutions: ['720P'],
        defaultResolution: '720P',
        durations: [6],
        defaultDuration: 6,
        supportsFirstFrame: true,
        ...extra,
      })
    }
  }
  return null
}

/** 取视频模型档案（H3 / 经典统一入口） */
export function getMiniMaxVideoProfile(model: string | null | undefined): MiniMaxVideoProfile | null {
  return getH3Profile(model) ?? getClassicVideoProfile(model)
}

/** 图片模型档案 */
export interface MiniMaxImageProfile {
  model: string
  /** 是否支持参考图（subject_reference） */
  supportsReference: boolean
  /** 是否支持画风设置（image-01-live） */
  supportsStyle: boolean
  /** 官方支持的画风类型 */
  styleTypes: string[]
}

const IMAGE_PROFILES: MiniMaxImageProfile[] = [
  {
    model: 'image-01',
    supportsReference: true,
    supportsStyle: false,
    styleTypes: [],
  },
  {
    model: 'image-01-live',
    supportsReference: true,
    supportsStyle: true,
    styleTypes: ['漫画', '元气', '中世纪', '水彩'],
  },
]

export function getMiniMaxImageProfile(model: string | null | undefined): MiniMaxImageProfile {
  const m = String(model || '').trim()
  const lower = m.toLowerCase()
  for (const p of IMAGE_PROFILES) {
    if (lower === p.model.toLowerCase()) return p
  }
  for (const p of IMAGE_PROFILES) {
    if (lower.startsWith(p.model.toLowerCase())) return p
  }
  // 未知 image-01 变体：按最保守处理（不支持参考图与画风）
  return { model: m || 'image-01', supportsReference: false, supportsStyle: false, styleTypes: [] }
}

/** 国内站 / 国际站默认 host */
export const MINIMAX_HOSTS = {
  cn: 'https://api.minimaxi.com',
  global: 'https://api.minimax.io',
} as const
