/**
 * 应用设置路由 — 全局配置的读写入口（当前：AI 内容语言）
 */
import { Hono } from 'hono'
import { getContentLanguage, setContentLanguage, getToursSeen, setToursSeen, CONTENT_LANGUAGES, type ContentLanguage } from '../services/app-settings.js'
import {
  getMaskedStorageSyncConfig,
  saveStorageSyncConfig,
  testStorageSyncConnection,
  type StorageSyncSettings,
} from '../services/storage-sync.js'
import { success, badRequest } from '../utils/response.js'

const app = new Hono()

// GET /content-language — 当前 AI 内容语言
app.get('/content-language', async (c) => {
  return success(c, { language: await getContentLanguage() })
})

// PUT /content-language — 设置 AI 内容语言（body: { language: 'zh'|'en'|'ja'|'ko' }）
app.put('/content-language', async (c) => {
  const body = await c.req.json().catch(() => null)
  const language = body?.language
  if (!(CONTENT_LANGUAGES as readonly string[]).includes(language)) {
    return badRequest(c, `language 必须是 ${CONTENT_LANGUAGES.join(' / ')} 之一`)
  }
  const saved = await setContentLanguage(language as ContentLanguage)
  return success(c, { language: saved })
})

// GET /tours-seen — 已看过的引导漫游 id 列表
app.get('/tours-seen', async (c) => {
  return success(c, { seen: await getToursSeen() })
})

// PUT /tours-seen — 写入已看过的引导漫游 id 列表（body: { seen: string[] }）
app.put('/tours-seen', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!Array.isArray(body?.seen) || !body.seen.every((v: unknown) => typeof v === 'string')) {
    return badRequest(c, 'seen 必须是字符串数组')
  }
  return success(c, { seen: await setToursSeen(body.seen) })
})

// GET /storage-sync — 获取资产存储与公网同步配置（密钥脱敏）
app.get('/storage-sync', async (c) => {
  return success(c, getMaskedStorageSyncConfig())
})

// PUT /storage-sync — 保存资产存储与公网同步配置
app.put('/storage-sync', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Partial<StorageSyncSettings> | null
  if (!body || typeof body !== 'object') {
    return badRequest(c, '请求体格式错误')
  }
  try {
    const saved = saveStorageSyncConfig(body)
    return success(c, saved)
  } catch (err: any) {
    return badRequest(c, `保存存储配置失败: ${err?.message || err}`)
  }
})

// POST /storage-sync/test — 测试资产存储或 Web 服务公网连通性
app.post('/storage-sync/test', async (c) => {
  const body = (await c.req.json().catch(() => null)) as StorageSyncSettings | null
  try {
    const res = await testStorageSyncConnection(body || undefined)
    return success(c, res)
  } catch (err: any) {
    return badRequest(c, err?.message || String(err))
  }
})

export default app
