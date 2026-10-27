import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MiniMaxImageAdapter } from '../src/services/adapters/minimax-image'
import { MiniMaxVideoAdapter } from '../src/services/adapters/minimax-video'
import { ProviderError } from '../src/services/adapters/errors'
import { isH3Model, isClassicVideoModel, parseBaseResp } from '../src/services/adapters/minimax-common'
import { joinProviderUrl } from '../src/services/adapters/url'

const imageAdapter = new MiniMaxImageAdapter()
const videoAdapter = new MiniMaxVideoAdapter()

const imageConfig = {
  provider: 'minimax',
  baseUrl: 'https://api.minimaxi.com',
  apiKey: 'sk-minimax-test',
  model: 'image-01',
}

const videoConfig = {
  provider: 'minimax',
  baseUrl: 'https://api.minimaxi.com',
  apiKey: 'sk-minimax-test',
  model: 'MiniMax-H3',
}

// ─── 图片 ────────────────────────────────────────────────────────

test('MiniMax image request targets /v1/image_generation with bearer auth', () => {
  const req = imageAdapter.buildGenerateRequest(imageConfig, {
    id: 1,
    model: 'image-01',
    prompt: 'a red apple',
    size: '1920x1080',
  })
  assert.equal(req.url, 'https://api.minimaxi.com/v1/image_generation')
  assert.equal(req.method, 'POST')
  assert.equal(req.headers.Authorization, 'Bearer sk-minimax-test')
  assert.equal(req.body.model, 'image-01')
  assert.equal(req.body.prompt, 'a red apple')
  assert.equal(req.body.n, 1)
  assert.equal(req.body.response_format, 'url')
  // 1920x1080 落在官方像素区间且是 8 的倍数 → 直接给精确尺寸
  assert.equal(req.body.width, 1920)
  assert.equal(req.body.height, 1080)
})

test('MiniMax image request scales out-of-range sizes while keeping the aspect ratio', () => {
  const req = imageAdapter.buildGenerateRequest(imageConfig, {
    id: 1,
    prompt: 'x',
    size: '100x100',
  })
  // 100x100 低于官方下限 → 等比放大到 512x512（不拉伸、不丢比例）
  assert.equal(req.body.width, 512)
  assert.equal(req.body.height, 512)
  assert.equal(req.body.aspect_ratio, undefined)
})

test('MiniMax image request falls back to aspect_ratio for non numeric sizes', () => {
  const req = imageAdapter.buildGenerateRequest(imageConfig, {
    id: 1,
    prompt: 'x',
    size: 'auto',
  })
  assert.equal(req.body.width, undefined)
  assert.equal(req.body.height, undefined)
  assert.equal(req.body.aspect_ratio, '16:9')
})

test('MiniMax image request rejects over-long prompts with actionable detail', () => {
  assert.throws(
    () => imageAdapter.buildGenerateRequest(imageConfig, { id: 1, prompt: 'x'.repeat(1501) }),
    (err: any) => {
      assert.ok(err instanceof ProviderError)
      assert.equal(err.detail.stage, 'config')
      assert.match(err.detail.message, /1500/)
      assert.ok(err.detail.hint)
      return true
    },
  )
})

test('MiniMax image request maps a public reference image to subject_reference', () => {
  const req = imageAdapter.buildGenerateRequest(imageConfig, {
    id: 1,
    prompt: 'x',
    referenceImages: JSON.stringify(['https://example.com/ref.png']),
  })
  assert.deepEqual(req.body.subject_reference, [
    { type: 'character', image_file: 'https://example.com/ref.png' },
  ])
})

test('MiniMax image request refuses inline data URL references with a fix hint', () => {
  assert.throws(
    () => imageAdapter.buildGenerateRequest(imageConfig, {
      id: 1,
      prompt: 'x',
      referenceImages: JSON.stringify(['data:image/png;base64,AAA']),
    }),
    (err: any) => {
      assert.ok(err instanceof ProviderError)
      assert.match(err.detail.message, /PUBLIC_BASE_URL|公网/)
      return true
    },
  )
})

test('MiniMax image parses a synchronous image_urls response', () => {
  const parsed = imageAdapter.parseGenerateResponse({
    id: 'trace-1',
    data: { image_urls: ['https://cdn.example.com/a.jpg'] },
    metadata: { success_count: '1', failed_count: '0' },
    base_resp: { status_code: 0, status_msg: 'success' },
  })
  assert.equal(parsed.isAsync, false)
  assert.equal(parsed.imageUrl, 'https://cdn.example.com/a.jpg')
})

test('MiniMax image surfaces base_resp business errors even on HTTP 200', () => {
  assert.throws(
    () => imageAdapter.parseGenerateResponse({
      base_resp: { status_code: 1026, status_msg: 'content moderation failed' },
    }),
    (err: any) => {
      assert.ok(err instanceof ProviderError)
      assert.equal(err.detail.providerCode, 1026)
      assert.equal(err.detail.providerMessage, 'content moderation failed')
      assert.equal(err.detail.stage, 'response')
      assert.ok(err.detail.hint && err.detail.hint.length > 0)
      return true
    },
  )
})

test('MiniMax image exposes base64 payloads when the provider returns them', () => {
  const b64 = imageAdapter.extractImageBase64({ data: { image_base64: ['QUJD'] } })
  assert.deepEqual(b64, { data: 'QUJD', mimeType: 'image/jpeg' })
  assert.equal(imageAdapter.extractImageUrl({ data: { image_urls: ['u'] } }), 'u')
})

// ─── 视频：H3（v2 接口） ─────────────────────────────────────────

test('MiniMax H3 video request uses the v2 content array contract', () => {
  const req = videoAdapter.buildGenerateRequest(videoConfig, {
    id: 1,
    model: 'MiniMax-H3',
    prompt: '@图片1女孩 走进房间',
    duration: 8,
    resolution: '1080p',
    aspectRatio: '9:16',
  })
  assert.equal(req.url, 'https://api.minimaxi.com/v2/video_generation')
  assert.equal(req.body.model, 'MiniMax-H3')
  assert.equal(req.body.content[0].type, 'text')
  assert.equal(req.body.content[0].text, '@图片1女孩 走进房间')
  assert.equal(req.body.duration, 8)
  assert.equal(req.body.resolution, '2K')
  assert.equal(req.body.ratio, '9:16')
})

test('MiniMax H3 video request omits ratio when a first frame is provided', () => {
  const req = videoAdapter.buildGenerateRequest(videoConfig, {
    id: 1,
    model: 'MiniMax-H3',
    prompt: 'x',
    firstFrameUrl: 'https://example.com/first.png',
  })
  assert.equal(req.body.ratio, undefined)
  assert.deepEqual(req.body.content[1], {
    type: 'image_url',
    image_url: { url: 'https://example.com/first.png' },
    role: 'first_frame',
  })
})

test('MiniMax H3 video rejects unsupported models with a model list hint', () => {
  assert.throws(
    () => videoAdapter.buildGenerateRequest({ ...videoConfig, model: 'gpt-video' }, { id: 1, prompt: 'x' }),
    (err: any) => {
      assert.ok(err instanceof ProviderError)
      assert.equal(err.detail.stage, 'config')
      assert.match(err.detail.hint || '', /MiniMax-H3/)
      return true
    },
  )
})

test('MiniMax H3 poll request uses the v2 task path', () => {
  const req = videoAdapter.buildPollRequest(videoConfig, 'task-123', { model: 'MiniMax-H3' })
  assert.equal(req.url, 'https://api.minimaxi.com/v2/query/video_generation/task-123')
  assert.equal(req.method, 'GET')
})

test('MiniMax H3 poll response maps succeeded to completed with the video url', () => {
  const parsed = videoAdapter.parsePollResponse({
    task: { status: 'succeeded', content: { url: 'https://cdn.example.com/v.mp4' }, duration: 6 },
  })
  assert.equal(parsed.status, 'completed')
  assert.equal(parsed.videoUrl, 'https://cdn.example.com/v.mp4')
  assert.equal(parsed.duration, 6)
})

test('MiniMax H3 poll response maps failed to a readable error', () => {
  const parsed = videoAdapter.parsePollResponse({
    task: { status: 'failed', error: { code: 'content_blocked', message: 'prompt blocked' } },
  })
  assert.equal(parsed.status, 'failed')
  assert.match(parsed.error || '', /content_blocked/)
  assert.match(parsed.error || '', /prompt blocked/)
})

// ─── 视频：经典 Hailuo（v1 接口） ────────────────────────────────

test('MiniMax classic video request uses the v1 prompt contract', () => {
  const req = videoAdapter.buildGenerateRequest(
    { ...videoConfig, model: 'MiniMax-Hailuo-2.3' },
    { id: 1, model: 'MiniMax-Hailuo-2.3', prompt: 'a cat playing', duration: 6, resolution: '1080p' },
  )
  assert.equal(req.url, 'https://api.minimaxi.com/v1/video_generation')
  assert.equal(req.body.prompt, 'a cat playing')
  assert.equal(req.body.duration, 6)
  assert.equal(req.body.resolution, '1080P')
  assert.equal(req.body.prompt_optimizer, true)
})

test('MiniMax classic video duration is normalized to 6 or 10 seconds', () => {
  // Hailuo-2.3 支持 6s / 10s 两档
  const five = videoAdapter.buildGenerateRequest(
    { ...videoConfig, model: 'MiniMax-Hailuo-2.3' },
    { id: 1, model: 'MiniMax-Hailuo-2.3', prompt: 'x', duration: 5 },
  )
  assert.equal(five.body.duration, 6)
  const eight = videoAdapter.buildGenerateRequest(
    { ...videoConfig, model: 'MiniMax-Hailuo-2.3' },
    { id: 1, model: 'MiniMax-Hailuo-2.3', prompt: 'x', duration: 8 },
  )
  assert.equal(eight.body.duration, 10)
  // T2V-01 系列官方只支持 6s，8s 不能被抬成 10s
  const legacy = videoAdapter.buildGenerateRequest(
    { ...videoConfig, model: 'T2V-01' },
    { id: 1, model: 'T2V-01', prompt: 'x', duration: 8 },
  )
  assert.equal(legacy.body.duration, 6)
})

test('MiniMax classic video poll request carries the task id as a query parameter', () => {
  const req = videoAdapter.buildPollRequest(
    { ...videoConfig, model: 'MiniMax-Hailuo-2.3' },
    'task 9',
    { model: 'MiniMax-Hailuo-2.3' },
  )
  assert.equal(req.url, 'https://api.minimaxi.com/v1/query/video_generation?task_id=task%209')
})

test('MiniMax classic video poll response exposes the file id for retrieval', () => {
  const parsed = videoAdapter.parsePollResponse({
    task_id: 'task-9',
    status: 'Success',
    file_id: 'file-9',
    base_resp: { status_code: 0, status_msg: 'success' },
  })
  assert.equal(parsed.status, 'completed')
  assert.equal(parsed.fileId, 'file-9')
})

test('MiniMax classic video delivery recovery is not offered', () => {
  // 只有 v2（H3）链路有独立的恢复入口，v1 系列没有对应能力
  assert.throws(
    () => videoAdapter.buildRecoveryRequest(
      { ...videoConfig, model: 'MiniMax-Hailuo-2.3' },
      'task-9',
      { model: 'MiniMax-Hailuo-2.3' },
    ),
    (err: any) => {
      assert.ok(err instanceof ProviderError)
      assert.equal(err.detail.stage, 'config')
      return true
    },
  )
})

test('MiniMax H3 delivery recovery keeps the v2 recovery path', () => {
  const req = videoAdapter.buildRecoveryRequest(videoConfig, 'task-1', { model: 'MiniMax-H3' })
  assert.equal(req.url, 'https://api.minimaxi.com/v2/query/video_generation/task-1/recover')
  assert.equal(req.method, 'POST')
})

// ─── 工具函数 ────────────────────────────────────────────────────

test('MiniMax model family detection separates v2 and v1 video models', () => {
  assert.equal(isH3Model('MiniMax-H3'), true)
  assert.equal(isH3Model('minimax-h3-max'), true)
  assert.equal(isH3Model('MiniMax-Hailuo-2.3'), false)
  assert.equal(isClassicVideoModel('MiniMax-Hailuo-2.3'), true)
  assert.equal(isClassicVideoModel('T2V-01-Director'), true)
  assert.equal(isClassicVideoModel('I2V-01'), true)
  assert.equal(isClassicVideoModel('S2V-01'), true)
  assert.equal(isClassicVideoModel('MiniMax-H3'), false)
  assert.equal(isClassicVideoModel('gpt-video'), false)
})

test('MiniMax base_resp parsing reads status code and message', () => {
  assert.deepEqual(parseBaseResp({ base_resp: { status_code: 1004, status_msg: 'authentication failed' } }), {
    statusCode: 1004,
    statusMsg: 'authentication failed',
  })
  assert.deepEqual(parseBaseResp({}), {})
})

test('provider URL builder keeps query strings out of the path', () => {
  // '?' 被写进 pathname 会被百分号编码成 %3F，查询参数必须单独处理
  assert.equal(
    joinProviderUrl('https://api.minimaxi.com', '/v1', '/query/video_generation?task_id=abc'),
    'https://api.minimaxi.com/v1/query/video_generation?task_id=abc',
  )
  assert.equal(
    joinProviderUrl('https://gw.example.com/minimax', '/v1', '/query/video_generation?task_id=t%201'),
    'https://gw.example.com/minimax/v1/query/video_generation?task_id=t%201',
  )
  assert.equal(
    joinProviderUrl('https://api.minimaxi.com', '/v1', '/image_generation'),
    'https://api.minimaxi.com/v1/image_generation',
  )
  assert.equal(
    joinProviderUrl('https://api.openai.com', '/v1', '/models'),
    'https://api.openai.com/v1/models',
  )
})
