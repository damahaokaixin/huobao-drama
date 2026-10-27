/**
 * MiniMax 订阅套餐（Token Plan / M Plan）测试
 *
 * 重点：订阅 Key（sk-cp）与按量计费 Key（sk-api）走的是同一批端点，
 * 区别只在「失败时该怎么解释」和「额度窗口怎么算」，
 * 所以这里锁死 Key 识别、额度解析与错误归因三条链路。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildQuotaUrls,
  detectMiniMaxKeyType,
  fetchMiniMaxPlanQuota,
  isModelCoveredByPlan,
  parsePlanQuota,
  planBillingHint,
  planCoverageHint,
} from '../src/services/adapters/minimax-plan'

// ─── Key 类型识别 ──────────────────────────────────────────────────

test('MiniMax key type detection distinguishes subscription and pay-as-you-go keys', () => {
  assert.equal(detectMiniMaxKeyType('sk-cp-abc123'), 'subscription')
  assert.equal(detectMiniMaxKeyType('SK-CP-ABC'), 'subscription')
  assert.equal(detectMiniMaxKeyType('sk-api-abc123'), 'payg')
  assert.equal(detectMiniMaxKeyType('sk-api-abc123'), 'payg')
  assert.equal(detectMiniMaxKeyType('some-gateway-key'), 'unknown')
  assert.equal(detectMiniMaxKeyType(''), 'unknown')
  assert.equal(detectMiniMaxKeyType(null), 'unknown')
})

// ─── 额度端点 ──────────────────────────────────────────────────────

test('quota URLs cover the documented path plus the legacy coding plan path', () => {
  const urls = buildQuotaUrls('https://api.minimaxi.com')
  assert.ok(urls.includes('https://api.minimaxi.com/v1/token_plan/remains'))
  assert.ok(urls.includes('https://api.minimaxi.com/v1/coding_plan/remains'))
  // 国内站与国际站都提供 www 主机兜底
  assert.ok(urls.some(u => u.startsWith('https://www.minimaxi.com/v1/token_plan/remains')))
})

test('quota URLs keep a gateway base path intact', () => {
  const urls = buildQuotaUrls('https://gw.example.com/minimax')
  assert.equal(urls[0], 'https://gw.example.com/minimax/v1/token_plan/remains')
})

// ─── 额度解析 ──────────────────────────────────────────────────────

test('plan quota parsing reads the 5 hour and weekly windows from a data wrapper', () => {
  const parsed = parsePlanQuota({
    base_resp: { status_code: 0, status_msg: 'success' },
    data: {
      current_interval_total_count: 500,
      current_interval_usage_count: 120,
      current_interval_reset_time: '2026-06-19T21:00:00+08:00',
      current_weekly_total_count: 3500,
      current_weekly_usage_count: 840,
      current_weekly_reset_time: '2026-06-23T00:00:00+08:00',
    },
  })
  assert.deepEqual(parsed.interval, {
    total: 500,
    used: 120,
    remaining: 380,
    percentRemaining: 76,
    resetTime: '2026-06-19T21:00:00+08:00',
  })
  assert.equal(parsed.weekly?.remaining, 2660)
  assert.equal(parsed.weekly?.percentRemaining, 76)
})

test('plan quota parsing also accepts a top level response without a data wrapper', () => {
  const parsed = parsePlanQuota({
    current_interval_total_count: 100,
    current_interval_usage_count: 25,
  })
  assert.equal(parsed.interval?.remaining, 75)
  assert.equal(parsed.interval?.percentRemaining, 75)
})

test('plan quota parsing normalizes per model remainders', () => {
  const parsed = parsePlanQuota({
    model_remains: [
      { model: 'MiniMax-M3', remains: 450, total: 500 },
      { model_name: 'video', current_interval_total_count: 10, current_interval_usage_count: 2 },
    ],
  })
  assert.equal(parsed.models.length, 2)
  assert.equal(parsed.models[0].model, 'MiniMax-M3')
  assert.equal(parsed.models[0].percentRemaining, 90)
  assert.equal(parsed.models[1].model, 'video')
  assert.equal(parsed.models[1].remaining, 8)
})

// ─── 错误归因 ──────────────────────────────────────────────────────

test('plan billing hint explains an exhausted subscription window', () => {
  const hint = planBillingHint(2056, 'Token Plan usage window exceeded', 'subscription')
  assert.ok(hint)
  assert.match(hint, /窗口/)
  assert.match(hint, /积分包|按量/)
})

test('plan billing hint separates an exhausted plan from an empty wallet', () => {
  const subscription = planBillingHint(1008, 'insufficient balance', 'subscription')
  const payg = planBillingHint(1008, 'insufficient balance', 'payg')
  assert.match(subscription || '', /套餐|额度/)
  assert.doesNotMatch(subscription || '', /充值/)
  assert.match(payg || '', /余额|充值/)
})

test('plan billing hint reports a missing subscription plan', () => {
  const hint = planBillingHint(2062, 'no active token plan', 'subscription')
  assert.match(hint || '', /订阅计划|Token Plan|M Plan/)
})

test('plan billing hint stays silent for unrelated errors', () => {
  assert.equal(planBillingHint(1026, 'content moderation failed', 'subscription'), undefined)
})

test('plan billing hint makes an authentication failure key-type and region aware', () => {
  const subscription = planBillingHint(1004, 'login fail', 'subscription')
  const payg = planBillingHint(1004, 'login fail', 'payg')
  assert.match(subscription || '', /订阅 Key/)
  assert.match(subscription || '', /api\.minimaxi\.com|api\.minimax\.io/)
  assert.match(payg || '', /按量计费/)
})

// ─── 套餐覆盖范围 ──────────────────────────────────────────────────

test('plan coverage marks H3 as excluded from the legacy token plan', () => {
  assert.equal(isModelCoveredByPlan('MiniMax-H3'), false)
  assert.equal(isModelCoveredByPlan('MiniMax-H3-Max'), false)
  assert.equal(isModelCoveredByPlan('MiniMax-Hailuo-2.3'), true)
  assert.equal(isModelCoveredByPlan('image-01'), true)
  assert.equal(isModelCoveredByPlan('MiniMax-M3'), true)
  assert.equal(isModelCoveredByPlan(''), null)
})

test('plan coverage hint explains the H3 pay-as-you-go requirement', () => {
  const hint = planCoverageHint('MiniMax-H3')
  assert.ok(hint)
  assert.match(hint, /H3/)
  assert.match(hint, /按量|M Plan/)
  assert.equal(planCoverageHint('MiniMax-M3'), undefined)
})

// ─── 额度查询 ──────────────────────────────────────────────────────

test('quota query succeeds against the documented response shape', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        base_resp: { status_code: 0, status_msg: 'success' },
        data: {
          current_interval_total_count: 500,
          current_interval_usage_count: 100,
          current_weekly_total_count: 2000,
          current_weekly_usage_count: 400,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as any
  try {
    const quota = await fetchMiniMaxPlanQuota('https://api.minimaxi.com', 'sk-cp-test')
    assert.equal(quota.ok, true)
    assert.equal(quota.keyType, 'subscription')
    assert.equal(quota.interval?.remaining, 400)
    assert.equal(quota.weekly?.remaining, 1600)
    assert.match(quota.message, /5 小时窗口/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('quota query reports an unauthorized pay-as-you-go key with a fix hint', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        base_resp: {
          status_code: 1004,
          status_msg: "login fail: Please carry the API secret key in the 'Authorization' field of the request header",
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as any
  try {
    const quota = await fetchMiniMaxPlanQuota('https://api.minimaxi.com', 'sk-api-test')
    assert.equal(quota.ok, false)
    assert.equal(quota.providerCode, 1004)
    assert.match(quota.suggestion || '', /订阅 Key|sk-cp/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('quota query requires an api key', async () => {
  const quota = await fetchMiniMaxPlanQuota('https://api.minimaxi.com', '')
  assert.equal(quota.ok, false)
  assert.match(quota.message, /API Key/)
})
