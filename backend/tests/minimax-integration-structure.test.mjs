import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('../..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const exists = (path) => existsSync(new URL(path, root))

test('MiniMax is wired as an official provider for text, image and video', () => {
  const ai = read('backend/src/services/ai.ts')
  const registry = read('backend/src/services/adapters/registry.ts')

  assert.match(ai, /text:\s*\[[^\]]*'minimax'/)
  assert.match(ai, /image:\s*\[[^\]]*'minimax'/)
  assert.match(ai, /video:\s*\[[^\]]*'minimax'/)
  // 文本走 OpenAI 兼容协议（/v1）
  assert.match(ai, /provider === 'minimax'[\s\S]{0,160}joinProviderUrl\(config\.baseUrl,\s*'\/v1',\s*''\)/)

  // 图片 / 视频适配器都已注册
  assert.match(registry, /minimax:\s*new MiniMaxImageAdapter\(\)/)
  assert.match(registry, /minimax:\s*new MiniMaxVideoAdapter\(\)/)
  assert.equal(exists('backend/src/services/adapters/minimax-image.ts'), true)
  assert.equal(exists('backend/src/services/adapters/minimax-video.ts'), true)
  assert.equal(exists('backend/src/services/adapters/minimax-common.ts'), true)
})

test('MiniMax adapters validate the base_resp business status instead of trusting HTTP 200', () => {
  const common = read('backend/src/services/adapters/minimax-common.ts')
  const image = read('backend/src/services/adapters/minimax-image.ts')
  const video = read('backend/src/services/adapters/minimax-video.ts')

  assert.match(common, /status_code/)
  assert.match(common, /assertMiniMaxOk/)
  assert.match(image, /assertMiniMaxOk/)
  assert.match(video, /assertMiniMaxOk/)
  // 错误码 → 中文可操作提示
  assert.match(common, /1004/)
  assert.match(common, /1008/)
  assert.match(common, /1039/)
})

test('MiniMax video adapter supports both the v2 (H3) and the classic v1 (Hailuo) interfaces', () => {
  const video = read('backend/src/services/adapters/minimax-video.ts')

  assert.match(video, /'\/v2', '\/video_generation'/)
  assert.match(video, /'\/v1', '\/video_generation'/)
  assert.match(video, /query\/video_generation\/\$\{taskId\}/)
  assert.match(video, /query\/video_generation\?task_id=/)
  assert.match(video, /files\/retrieve\?file_id=/)
  assert.match(video, /MiniMax-Hailuo/)
  assert.match(video, /T2V-01-Director|I2V-01|S2V-01/)
})

test('MiniMax text agent requests avoid parameters the provider rejects', () => {
  const agents = read('backend/src/agents/index.ts')

  // MiniMax 只认 max_completion_tokens；不注入 enable_thinking / reasoning_effort
  assert.match(agents, /createMiniMaxTextFetch/)
  assert.match(agents, /body\.max_completion_tokens = defaultMaxTokens/)
  assert.match(agents, /delete body\.max_tokens/)
})

test('connection test performs real calls and returns actionable failure details', () => {
  const test = read('backend/src/services/ai-connection-test.ts')
  const route = read('backend/src/routes/aiConfigs.ts')
  const errors = read('backend/src/services/adapters/errors.ts')

  assert.match(test, /runConnectionTest/)
  // 文本真实发起一次对话
  assert.match(test, /chat\/completions/)
  // 图片真实生图
  assert.match(test, /image_generation/)
  // 视频真实提交任务
  assert.match(test, /video_generation/)
  // 失败时给出可操作建议
  assert.match(test, /suggestion/)
  assert.match(test, /hintForCode/)

  assert.match(route, /runConnectionTest/)
  assert.match(route, /runLightProbe/)
  assert.match(route, /mode === 'light'/)

  assert.match(errors, /class ProviderError/)
  assert.match(errors, /ProviderErrorDetail/)
  assert.match(errors, /hint\?/)
})

test('failed generation tasks persist a structured failure detail', () => {
  const schema = read('backend/src/db/schema.ts')
  const sqliteSchema = read('backend/src/db/sqlite-schema.ts')
  const generation = read('backend/src/services/generation.ts')
  const tasksRoute = read('backend/src/routes/tasks.ts')

  assert.match(schema, /errorDetail: text\('error_detail'\)/)
  assert.match(sqliteSchema, /error_detail TEXT/)
  assert.match(sqliteSchema, /ALTER TABLE sys_task ADD COLUMN \$\{name\} \$\{type\}/)
  assert.match(generation, /errorDetail: JSON\.stringify\(detail\)/)
  assert.match(generation, /toProviderErrorDetail/)
  assert.match(tasksRoute, /errorDetail: parseErrorDetail\(task\.errorDetail\)/)
})

test('the settings page exposes real / light test entry points and failure detail UI', () => {
  const settings = read('frontend/app/pages/settings.vue')
  const episode = read('frontend/app/views/drama/episode.vue')
  const zh = JSON.parse(read('frontend/app/locales/zh.json'))

  assert.match(settings, /testDraftCfg\('real'\)/)
  assert.match(settings, /testDraftCfg\('light'\)/)
  assert.match(settings, /cfgTestResult\.suggestion/)
  assert.match(settings, /cfgTestResult\.latency_ms/)
  assert.match(settings, /cfgTestResult\.provider_code/)

  assert.match(episode, /openFailureDetail/)
  assert.match(episode, /failure-detail-dialog/)
  assert.ok(zh.settings.cfg.testReal)
  assert.ok(zh.settings.cfg.testLight)
  assert.ok(zh.episode.recovery.failureDetail)
  assert.ok(zh.episode.recovery.failureHint)
})

test('MiniMax subscription plan (Token Plan / M Plan) is a first class integration', () => {
  const plan = read('backend/src/services/adapters/minimax-plan.ts')
  const route = read('backend/src/routes/aiConfigs.ts')
  const common = read('backend/src/services/adapters/minimax-common.ts')
  const test = read('backend/src/services/ai-connection-test.ts')

  assert.equal(exists('backend/src/services/adapters/minimax-plan.ts'), true)

  // 订阅 Key（sk-cp）与按量 Key（sk-api）必须能区分
  assert.match(plan, /sk-cp/)
  assert.match(plan, /sk-api/)
  assert.match(plan, /detectMiniMaxKeyType/)

  // 额度查询端点与套餐窗口
  assert.match(plan, /token_plan\/remains/)
  assert.match(plan, /coding_plan\/remains/)
  assert.match(plan, /current_interval_total_count/)
  assert.match(plan, /current_weekly_total_count/)

  // 订阅相关的错误码：额度窗口用尽 / 没有生效的订阅计划
  assert.match(common, /2056/)
  assert.match(common, /2062/)
  assert.match(plan, /planBillingHint/)
  assert.match(plan, /planCoverageHint/)

  // 失败诊断要按 Key 类型给出不同建议
  assert.match(test, /detectMiniMaxKeyType/)
  assert.match(test, /applyMiniMaxPlanHint/)

  // 额度查询接口
  assert.match(route, /plan-quota/)
  assert.match(route, /fetchMiniMaxPlanQuota/)
})

test('MiniMax model capability profiles drive per model parameter normalization', () => {
  const common = read('backend/src/services/adapters/minimax-common.ts')
  const video = read('backend/src/services/adapters/minimax-video.ts')
  const image = read('backend/src/services/adapters/minimax-image.ts')

  // H3 家族
  for (const model of ['MiniMax-H3-Highspeed', 'MiniMax-H3-Lite', 'MiniMax-H3-Max']) {
    assert.match(common, new RegExp(model.replace(/[-.]/g, '\\$&')))
  }
  // Hailuo 家族
  for (const model of ['MiniMax-Hailuo-2.3-Fast', 'MiniMax-Hailuo-02']) {
    assert.match(common, new RegExp(model.replace(/[-.]/g, '\\$&')))
  }
  // 图片模型
  assert.match(common, /image-01-live/)

  // 参数归一化走档案，而不是写死一套
  assert.match(video, /getH3Profile/)
  assert.match(video, /getClassicVideoProfile/)
  assert.match(video, /pickResolution/)
  assert.match(video, /pickDuration/)

  // 首尾帧插值只有 Hailuo-02 支持
  assert.match(video, /supportsLastFrame/)
  // 首帧必填的模型
  assert.match(video, /requiresFirstFrame/)
  // 水印开关
  assert.match(video, /aigc_watermark/)

  // image-01-live 画风
  assert.match(image, /style_type/)
})

test('the settings page exposes the subscription plan quota panel and key type hint', () => {
  const settings = read('frontend/app/pages/settings.vue')
  const api = read('frontend/app/composables/useApi.ts')
  const zh = JSON.parse(read('frontend/app/locales/zh.json'))
  const en = JSON.parse(read('frontend/app/locales/en.json'))

  assert.match(settings, /queryPlanQuota/)
  assert.match(settings, /minimaxKeyType/)
  assert.match(settings, /keyTypeLabel/)
  assert.match(settings, /planQuotaWindows/)
  assert.match(api, /planQuota/)

  for (const locale of [zh, en]) {
    assert.ok(locale.settings.cfg.planQuotaTitle)
    assert.ok(locale.settings.cfg.planQuotaQuery)
    assert.ok(locale.settings.cfg.keyTypeSubscription)
    assert.ok(locale.settings.cfg.keyHintSubscription)
    assert.ok(locale.settings.cfg.keyHintPayg)
  }
})

test('image generation carries the MiniMax style setting end to end', () => {
  const generation = read('backend/src/services/generation.ts')
  const characters = read('backend/src/routes/characters.ts')
  const scenes = read('backend/src/routes/scenes.ts')
  const props = read('backend/src/routes/props.ts')
  const episode = read('frontend/app/views/drama/episode.vue')
  const zh = JSON.parse(read('frontend/app/locales/zh.json'))

  assert.match(generation, /style: params\.style/)
  assert.match(characters, /style: body\.style/)
  assert.match(scenes, /style: body\.style/)
  assert.match(props, /style: body\.style/)
  assert.match(episode, /imageStyle/)
  assert.ok(zh.episode.topbar.imageStyle)
})
