import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { db, schema } from '../src/db/index.js'
import { eq } from 'drizzle-orm'
import { saveStorageSyncConfig, resolvePublicAssetUrl, resolvePublicAssetUrls } from '../src/services/storage-sync.js'
import { MiniMaxVideoAdapter } from '../src/services/adapters/minimax-video.js'

let originalRow: any = null

before(() => {
  originalRow = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, 'storage_sync_config'))
    .get()
})

after(() => {
  if (originalRow) {
    db.insert(schema.appSettings)
      .values(originalRow)
      .onConflictDoUpdate({
        target: schema.appSettings.key,
        set: originalRow,
      })
      .run()
  } else {
    db.delete(schema.appSettings)
      .where(eq(schema.appSettings.key, 'storage_sync_config'))
      .run()
  }
})

test('MiniMax H3 generation: truly resolves and invokes Web / Storage config for local assets', async () => {
  // 1. 设置公网 Web 访问配置
  saveStorageSyncConfig({
    mode: 'web_server',
    publicBaseUrl: 'https://assets.huobao-studio.com',
  })

  // 2. 模拟本地分镜素材路径
  const localFirstFrame = 'static/images/shot1_first.jpg'
  const localRefImages = ['static/images/char_xiaoming.png', 'static/images/scene_room.png']

  // 3. 执行公网解析（与 generation.ts dispatchTask 中一致）
  const resolvedFirstFrame = await resolvePublicAssetUrl(localFirstFrame, 'image')
  const resolvedRefImages = await resolvePublicAssetUrls(localRefImages, 'image')

  assert.equal(resolvedFirstFrame, 'https://assets.huobao-studio.com/static/images/shot1_first.jpg')
  assert.deepEqual(resolvedRefImages, [
    'https://assets.huobao-studio.com/static/images/char_xiaoming.png',
    'https://assets.huobao-studio.com/static/images/scene_room.png',
  ])

  // 4. 构建 MiniMax H3 视频请求
  const adapter = new MiniMaxVideoAdapter()
  const req = adapter.buildGenerateRequest(
    { provider: 'minimax', apiKey: 'sk-test', baseUrl: 'https://api.minimaxi.com' },
    {
      id: 1,
      model: 'MiniMax-H3',
      prompt: '镜头描述：小明走进房间',
      firstFrameUrl: resolvedFirstFrame,
      referenceImageUrls: JSON.stringify(resolvedRefImages),
      duration: 6,
      resolution: '720p',
    },
  )

  // 5. 校验发送给 MiniMax 的请求体 content 数组
  const body = req.body as any
  assert.equal(req.url, 'https://api.minimaxi.com/v2/video_generation')
  assert.ok(Array.isArray(body.content))

  // 首帧图 URL 是否带上了公网域名
  const firstFrameItem = body.content.find((item: any) => item.role === 'first_frame')
  assert.ok(firstFrameItem, 'MiniMax H3 request should contain first_frame')
  assert.equal(firstFrameItem.image_url.url, 'https://assets.huobao-studio.com/static/images/shot1_first.jpg')

  // 参考图 URL 是否带上了公网域名
  const refImageItems = body.content.filter((item: any) => item.role === 'reference_image')
  assert.equal(refImageItems.length, 2)
  assert.equal(refImageItems[0].image_url.url, 'https://assets.huobao-studio.com/static/images/char_xiaoming.png')
  assert.equal(refImageItems[1].image_url.url, 'https://assets.huobao-studio.com/static/images/scene_room.png')
})

test('MiniMax Hailuo classic generation: truly resolves and invokes Web / Storage config for first_frame_image', async () => {
  // 1. 设置公网 Web 访问配置
  saveStorageSyncConfig({
    mode: 'web_server',
    publicBaseUrl: 'https://assets.huobao-studio.com',
  })

  const localFirstFrame = 'static/images/hailuo_cover.png'
  const resolvedFirstFrame = await resolvePublicAssetUrl(localFirstFrame, 'image')

  // 2. 构建 MiniMax-Hailuo-2.3 请求
  const adapter = new MiniMaxVideoAdapter()
  const req = adapter.buildGenerateRequest(
    { provider: 'minimax', apiKey: 'sk-test', baseUrl: 'https://api.minimaxi.com' },
    {
      id: 2,
      model: 'MiniMax-Hailuo-2.3',
      prompt: '镜头描述：女孩微笑',
      firstFrameUrl: resolvedFirstFrame,
      duration: 6,
      resolution: '720p',
    },
  )

  const body = req.body as any
  assert.equal(req.url, 'https://api.minimaxi.com/v1/video_generation')
  // 校验海螺模型的 first_frame_image 是否成功被赋予公网地址
  assert.equal(body.first_frame_image, 'https://assets.huobao-studio.com/static/images/hailuo_cover.png')
})
