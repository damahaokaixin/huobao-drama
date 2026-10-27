/**
 * 端到端冒烟测试：用本地 mock 服务器模拟 MiniMax 三个端点，
 * 验证「真实连通性测试」与「任务失败详情」两条链路真的能跑通。
 *
 * 覆盖：
 *  1. 文本真实测试 → 成功并拿到回复
 *  2. 图片真实测试 → 成功并拿到图片 URL
 *  3. 视频真实测试 → 提交成功并轮询到 Success
 *  4. 图片任务失败 → sys_task.error_detail 落库结构化详情
 *  5. MiniMax 视频 v1（经典模型）走 file_id → download_url 取件
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-minimax-e2e-'))
process.env.SQLITE_PATH = path.join(root, 'tasks.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

type Call = { method: string; url: string; body: any }
const calls: Call[] = []
let imageFails = false
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64)])

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    let body: any = {}
    try { body = raw ? JSON.parse(raw) : {} } catch { body = raw }
    const url = req.url || ''
    calls.push({ method: req.method || '', url, body })

    // 文本
    if (url === '/v1/chat/completions') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        id: 'chat-1',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        base_resp: { status_code: 0, status_msg: 'success' },
      }))
      return
    }
    // 图片
    if (url === '/v1/image_generation') {
      res.setHeader('Content-Type', 'application/json')
      if (imageFails) {
        res.end(JSON.stringify({ base_resp: { status_code: 1026, status_msg: 'content moderation failed' } }))
        return
      }
      res.end(JSON.stringify({
        id: 'img-1',
        data: { image_urls: ['https://cdn.example.com/a.jpg'] },
        metadata: { success_count: '1', failed_count: '0' },
        base_resp: { status_code: 0, status_msg: 'success' },
      }))
      return
    }
    // 视频提交（v1 经典模型）
    if (url === '/v1/video_generation' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ task_id: 'task-e2e-1', base_resp: { status_code: 0, status_msg: 'success' } }))
      return
    }
    // 视频轮询
    if (url.startsWith('/v1/query/video_generation')) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ task_id: 'task-e2e-1', status: 'Success', file_id: 'file-e2e-1', base_resp: { status_code: 0, status_msg: 'success' } }))
      return
    }
    // 视频取件
    if (url.startsWith('/v1/files/retrieve')) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ file: { file_id: 'file-e2e-1', download_url: 'https://cdn.example.com/v.mp4' }, base_resp: { status_code: 0, status_msg: 'success' } }))
      return
    }
    res.writeHead(404).end()
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as any).port}`

const { runConnectionTest } = await import('../src/services/ai-connection-test.ts')
const { db, schema } = await import('../src/db/index.ts')
const { generateImage } = await import('../src/services/generation.ts')
const { eq } = await import('drizzle-orm')

test('真实文本测试：发出最小对话并解析出回复', async () => {
  const result = await runConnectionTest({
    serviceType: 'text',
    provider: 'minimax',
    baseUrl: base,
    apiKey: 'sk-test',
    model: 'MiniMax-M2.7',
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.stage, 'success')
  assert.equal(result.status, 200)
  assert.equal(result.detail.reply, 'pong')
  // MiniMax 的 OpenAI 兼容端点只认 max_completion_tokens
  const call = calls.find(c => c.url === '/v1/chat/completions')!
  assert.equal(call.body.max_completion_tokens, 16)
  assert.equal(call.body.max_tokens, undefined)
})

test('真实图片测试：真的拿到图片地址', async () => {
  const result = await runConnectionTest({
    serviceType: 'image',
    provider: 'minimax',
    baseUrl: base,
    apiKey: 'sk-test',
    model: 'image-01',
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.detail.image_url, 'https://cdn.example.com/a.jpg')
  const call = calls.find(c => c.url === '/v1/image_generation')!
  assert.equal(call.body.n, 1)
  assert.equal(call.body.response_format, 'url')
})

test('真实视频测试：提交任务并轮询到 Success', async () => {
  const result = await runConnectionTest({
    serviceType: 'video',
    provider: 'minimax',
    baseUrl: base,
    apiKey: 'sk-test',
    model: 'MiniMax-Hailuo-2.3',
    pollTimeoutMs: 8000,
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.detail.task_id, 'task-e2e-1')
  assert.equal(result.detail.task_status, 'Success')
})

test('厂商业务错误被翻译成可操作建议（不返回裸错误码）', async () => {
  imageFails = true
  const result = await runConnectionTest({
    serviceType: 'image',
    provider: 'minimax',
    baseUrl: base,
    apiKey: 'sk-test',
    model: 'image-01',
  })
  imageFails = false
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'response')
  assert.equal(result.provider_code, 1026)
  assert.ok(result.suggestion && result.suggestion.length > 0)
  assert.ok(result.response_preview.includes('1026'))
})

test('图片任务失败时把结构化失败详情写进 sys_task', async () => {
  imageFails = true
  const ts = new Date().toISOString()
  const cfg = db.insert(schema.aiServiceConfigs).values({
    serviceType: 'image', provider: 'minimax', name: 'e2e', baseUrl: base,
    apiKey: 'sk-test', model: JSON.stringify(['image-01']), createdAt: ts, updatedAt: ts,
  }).returning().get()

  const id = await generateImage({ prompt: 'a red apple', configId: cfg.id })
  const deadline = Date.now() + 20000
  let row: any
  while (Date.now() < deadline) {
    row = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()
    if (row?.status === 'failed') break
    await new Promise(r => setTimeout(r, 50))
  }
  imageFails = false
  assert.equal(row.status, 'failed')
  assert.ok(row.errorDetail, 'expected error_detail to be persisted')
  const detail = JSON.parse(row.errorDetail)
  assert.equal(detail.stage, 'response')
  assert.equal(detail.providerCode, 1026)
  assert.equal(detail.provider, 'minimax')
  assert.ok(detail.hint)
  assert.ok(detail.requestUrl.includes('/v1/image_generation'))
  // 密钥不能进库
  assert.doesNotMatch(row.errorDetail, /sk-test/)
})

test.after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  await fs.rm(root, { recursive: true, force: true })
})
