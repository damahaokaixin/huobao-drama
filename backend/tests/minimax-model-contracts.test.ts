/**
 * MiniMax 模型能力契约测试
 *
 * 覆盖 H3 家族（v2）与 Hailuo 经典系列（v1）各自的分辨率 / 时长 / 参考素材限制。
 * 这些限制差异很大，硬编码一套参数会在很多组合上直接被上游 400，
 * 所以这里逐条锁死适配器的归一化行为。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MiniMaxVideoAdapter } from '../src/services/adapters/minimax-video'
import { MiniMaxImageAdapter } from '../src/services/adapters/minimax-image'
import { ProviderError } from '../src/services/adapters/errors'
import {
  getClassicVideoProfile,
  getH3Profile,
  getMiniMaxImageProfile,
} from '../src/services/adapters/minimax-common'

const videoAdapter = new MiniMaxVideoAdapter()
const imageAdapter = new MiniMaxImageAdapter()

const baseConfig = {
  provider: 'minimax',
  baseUrl: 'https://api.minimaxi.com',
  apiKey: 'sk-test',
  model: 'MiniMax-H3',
}

function video(model: string, record: any = {}) {
  return videoAdapter.buildGenerateRequest(
    { ...baseConfig, model },
    { id: 1, model, prompt: 'a red apple', ...record },
  )
}

// ─── H3 家族 ──────────────────────────────────────────────────────

test('H3 family profiles expose the documented resolution and duration limits', () => {
  const h3 = getH3Profile('MiniMax-H3')!
  assert.deepEqual(h3.resolutions, ['2K', '768P'])
  assert.equal(h3.minDuration, 4)
  assert.equal(h3.maxDuration, 15)

  const highspeed = getH3Profile('MiniMax-H3-Highspeed')!
  assert.deepEqual(highspeed.resolutions, ['768P'], 'H3-Highspeed 官方不支持 2K')

  const lite = getH3Profile('MiniMax-H3-Lite')!
  assert.deepEqual(lite.resolutions, ['768P', '480P'])

  const max = getH3Profile('MiniMax-H3-Max')!
  assert.equal(max.minDuration, 5, 'H3-Max 最短 5s')
  assert.equal(max.maxDuration, 15)
  assert.ok(!max.resolutions.includes('2K'), 'H3-Max 不支持 2K')

  // 前缀匹配时更长���模型名优先：H3-Max 不能被 H3 抢走
  assert.equal(getH3Profile('MiniMax-H3-Max')!.model, 'MiniMax-H3-Max')
  assert.equal(getH3Profile('MiniMax-H3')!.model, 'MiniMax-H3')
})

test('H3-Highspeed downgrades a 2K request to 768P instead of failing upstream', () => {
  const req = video('MiniMax-H3-Highspeed', { resolution: '1080p', duration: 8 })
  assert.equal(req.body.resolution, '768P')
  assert.equal(req.body.duration, 8)
})

test('H3-Lite accepts 480P while plain H3 does not', () => {
  assert.equal(video('MiniMax-H3-Lite', { resolution: '480p' }).body.resolution, '480P')
  assert.equal(video('MiniMax-H3', { resolution: '480p' }).body.resolution, '768P')
})

test('H3-Max clamps the duration to its 5 second minimum', () => {
  assert.equal(video('MiniMax-H3-Max', { duration: 2 }).body.duration, 5)
  assert.equal(video('MiniMax-H3-Max', { duration: 30 }).body.duration, 15)
  assert.equal(video('MiniMax-H3', { duration: 2 }).body.duration, 4)
})

test('H3-Max-Turbo refuses multimodal reference material', () => {
  assert.throws(
    () => video('MiniMax-H3-Max-Turbo', { referenceImageUrls: JSON.stringify(['https://example.com/a.png']) }),
    (err: any) => {
      assert.ok(err instanceof ProviderError)
      assert.equal(err.detail.stage, 'config')
      assert.match(err.detail.message, /参考素材/)
      return true
    },
  )
})

test('H3 rejects a prompt longer than the documented limit', () => {
  assert.throws(
    () => video('MiniMax-H3', { prompt: 'x'.repeat(7001) }),
    (err: any) => {
      assert.ok(err instanceof ProviderError)
      assert.match(err.detail.message, /7000/)
      return true
    },
  )
})

// ─── Hailuo 经典系列（v1） ────────────────────────────────────────

test('Hailuo-2.3 maps the project 720p setting to the supported 768P tier', () => {
  // 720P 只属于 T2V/I2V/S2V 老模型，Hailuo-2.3 不支持，传上去会被上游拒绝
  const req = video('MiniMax-Hailuo-2.3', { resolution: '720p' })
  assert.equal(req.body.resolution, '768P')
})

test('Hailuo-2.3 keeps 1080P and downgrades a 10 second request to 6 seconds', () => {
  const req = video('MiniMax-Hailuo-2.3', { resolution: '1080p', duration: 10 })
  assert.equal(req.body.resolution, '1080P')
  assert.equal(req.body.duration, 6, '1080P 只支持 6s')
})

test('Hailuo-2.3 allows a 10 second video at 768P', () => {
  const req = video('MiniMax-Hailuo-2.3', { resolution: '720p', duration: 10 })
  assert.equal(req.body.resolution, '768P')
  assert.equal(req.body.duration, 10)
})

test('Hailuo-2.3-Fast requires a first frame image', () => {
  assert.throws(
    () => video('MiniMax-Hailuo-2.3-Fast'),
    (err: any) => {
      assert.ok(err instanceof ProviderError)
      assert.equal(err.detail.stage, 'config')
      assert.match(err.detail.message, /首帧/)
      return true
    },
  )
  const ok = video('MiniMax-Hailuo-2.3-Fast', { firstFrameUrl: 'https://example.com/f.png' })
  assert.equal(ok.body.first_frame_image, 'https://example.com/f.png')
})

test('last frame interpolation is only accepted by MiniMax-Hailuo-02', () => {
  assert.throws(
    () => video('MiniMax-Hailuo-2.3', { lastFrameUrl: 'https://example.com/l.png' }),
    (err: any) => {
      assert.ok(err instanceof ProviderError)
      assert.match(err.detail.message, /尾帧/)
      return true
    },
  )
  const ok = video('MiniMax-Hailuo-02', { lastFrameUrl: 'https://example.com/l.png' })
  assert.equal(ok.body.last_frame_image, 'https://example.com/l.png')
})

test('classic video request maps the watermark flag onto aigc_watermark', () => {
  assert.equal(video('MiniMax-Hailuo-2.3', { watermark: true }).body.aigc_watermark, true)
  assert.equal(video('MiniMax-Hailuo-2.3', { watermark: false }).body.aigc_watermark, false)
  assert.equal(video('MiniMax-Hailuo-2.3', {}).body.aigc_watermark, false)
})

test('classic video request keeps prompt_optimizer tied to the prompt extend flag', () => {
  assert.equal(video('MiniMax-Hailuo-2.3', { promptExtend: false }).body.prompt_optimizer, false)
  assert.equal(video('MiniMax-Hailuo-2.3', { promptExtend: true }).body.prompt_optimizer, true)
  assert.equal(video('MiniMax-Hailuo-2.3', {}).body.prompt_optimizer, true)
})

test('I2V-01 requires a first frame and S2V-01 requires a subject reference', () => {
  assert.throws(
    () => video('I2V-01'),
    (err: any) => {
      assert.ok(err instanceof ProviderError)
      assert.match(err.detail.message, /首帧/)
      return true
    },
  )
  assert.throws(
    () => video('S2V-01'),
    (err: any) => {
      assert.ok(err instanceof ProviderError)
      assert.match(err.detail.message, /角色参考图/)
      return true
    },
  )
  const s2v = video('S2V-01', { referenceImageUrls: JSON.stringify(['https://example.com/c.png']) })
  assert.deepEqual(s2v.body.subject_reference, [
    { type: 'character', image: ['https://example.com/c.png'] },
  ])
})

test('classic video profiles keep the legacy 720P tier for Director and 01 models', () => {
  const profile = getClassicVideoProfile('I2V-01-Director')!
  assert.deepEqual(profile.resolutions, ['720P'])
  assert.deepEqual(profile.durations, [6])
  assert.equal(video('I2V-01-Director', { resolution: '720p', duration: 6, firstFrameUrl: 'https://example.com/f.png' }).body.resolution, '720P')
})

test('classic video poll response exposes the produced resolution', () => {
  const parsed = videoAdapter.parsePollResponse({
    task_id: 'task-1',
    status: 'Success',
    file_id: 'file-1',
    video_width: 1920,
    video_height: 1080,
    base_resp: { status_code: 0, status_msg: 'success' },
  })
  assert.equal(parsed.status, 'completed')
  assert.equal(parsed.width, 1920)
  assert.equal(parsed.height, 1080)
  assert.equal(parsed.fileId, 'file-1')
})

test('classic video file retrieval carries both file_id and task_id', async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (url: any) => {
    calls.push(String(url))
    return new Response(
      JSON.stringify({ file: { download_url: 'https://cdn.example.com/v.mp4' }, base_resp: { status_code: 0, status_msg: 'success' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as any
  try {
    const url = await videoAdapter.resolveVideoUrl!(
      { ...baseConfig, model: 'MiniMax-Hailuo-2.3' },
      { status: 'completed', fileId: 'file-1' },
      { task_id: 'task-1', file_id: 'file-1' },
    )
    assert.equal(url, 'https://cdn.example.com/v.mp4')
    assert.match(calls[0], /\/v1\/files\/retrieve\?file_id=file-1/)
    assert.match(calls[0], /task_id=task-1/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ─── 图片模型 ──────────────────────────────────────────────────────

test('image-01-live accepts the documented style types', () => {
  const profile = getMiniMaxImageProfile('image-01-live')
  assert.equal(profile.supportsStyle, true)
  assert.deepEqual(profile.styleTypes, ['漫画', '元气', '中世纪', '水彩'])

  const req = imageAdapter.buildGenerateRequest(
    { ...baseConfig, model: 'image-01-live' },
    { id: 1, model: 'image-01-live', prompt: 'a cat', style: '漫画' },
  )
  assert.deepEqual(req.body.style, { style_type: '漫画' })
})

test('image-01 rejects a style setting with an actionable hint', () => {
  assert.throws(
    () => imageAdapter.buildGenerateRequest(
      { ...baseConfig, model: 'image-01' },
      { id: 1, model: 'image-01', prompt: 'a cat', style: '漫画' },
    ),
    (err: any) => {
      assert.ok(err instanceof ProviderError)
      assert.match(err.detail.message, /画风/)
      assert.match(err.detail.hint || '', /image-01-live/)
      return true
    },
  )
})

test('image-01-live rejects an unknown style type', () => {
  assert.throws(
    () => imageAdapter.buildGenerateRequest(
      { ...baseConfig, model: 'image-01-live' },
      { id: 1, model: 'image-01-live', prompt: 'a cat', style: '赛博朋克' },
    ),
    (err: any) => {
      assert.ok(err instanceof ProviderError)
      assert.match(err.detail.message, /赛博朋克/)
      return true
    },
  )
})

test('image-01-live still supports a public reference image', () => {
  const req = imageAdapter.buildGenerateRequest(
    { ...baseConfig, model: 'image-01-live' },
    {
      id: 1,
      model: 'image-01-live',
      prompt: 'a cat',
      style: '水彩',
      referenceImages: JSON.stringify(['https://example.com/r.png']),
    },
  )
  assert.deepEqual(req.body.subject_reference, [
    { type: 'character', image_file: 'https://example.com/r.png' },
  ])
})
