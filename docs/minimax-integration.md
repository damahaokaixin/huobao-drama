# MiniMax 模型渠道集成说明

本文档说明火宝短剧（huobao-drama）本次二次开发中 **MiniMax 系列模型** 的接入范围、
接口契约、配置方式，以及「真实连通性测试」与「失败详情」两套新增能力的实现细节。

---

## 1. 接入范围

MiniMax 现在是 `text` / `image` / `video` 三类服务的**官方厂商**（`officialProviders`）：

| 服务类型 | 适配器 | 端点 | 可用模型 |
|---|---|---|---|
| 文本 | AI SDK OpenAI 兼容通道 | `POST {base}/v1/chat/completions` | `MiniMax-M3`、`MiniMax-M3.1-Flash`、`MiniMax-M2.7`、`MiniMax-M2.5` |
| 图片 | `MiniMaxImageAdapter` | `POST {base}/v1/image_generation` | `image-01`、`image-01-live` |
| 视频（H3） | `MiniMaxVideoAdapter`（v2） | `POST {base}/v2/video_generation` | `MiniMax-H3`、`MiniMax-H3-Highspeed`、`MiniMax-H3-Lite`、`MiniMax-H3-Max`、`MiniMax-H3-Max-Turbo` |
| 视频（经典） | `MiniMaxVideoAdapter`（v1） | `POST {base}/v1/video_generation` | `MiniMax-Hailuo-2.3`、`MiniMax-Hailuo-2.3-Fast`、`MiniMax-Hailuo-02`、`T2V-01-Director`、`I2V-01`、`S2V-01`、`Video-01` |

> Base URL 只填**域名**（如 `https://api.minimaxi.com`），版本路径由各适配器按模型族自动拼��。
> 国内站 `api.minimaxi.com`，国际站 `api.minimax.io`，其余配置完全一致。

---

## 2. 文本通道

### 2.1 路由

`getTextProviderBaseUrl()`（`src/services/ai.ts`）对 `minimax` 返回 `{base}/v1`，
AI SDK 的 OpenAI provider 随后请求 `POST {base}/v1/chat/completions`，
与 MiniMax 的 OpenAI 兼容协议一致。

### 2.2 请求参数补丁（`src/agents/index.ts`）

MiniMax 与其它厂商有两处**必须区别对待**的参数差异，代码里用
`createMiniMaxTextFetch()` 单独处理：

1. **输出上限用 `max_completion_tokens`**，不是 `max_tokens`。
   M2.x 上限约 204800、M3 上限 524288。补丁会先 `delete body.max_tokens` 再写
   `max_completion_tokens = AI_MAX_TOKENS`（默认 16384）。
2. **绝不注入 `enable_thinking` / `reasoning_effort`**。这两���是 new-api / DeepSeek 系中转站的
   关思考参数，MiniMax 对未知参数直接返回 400。
   `thinking: { type: 'disabled' }` 只对 **M3 系**注入（M2.x 的 thinking 无法关闭）。

因此 MiniMax 不走通用的 `createThinkingOffFetch()` / `createMaxTokensFetch()` 补丁链。

### 2.3 常见报错

| 现象 | 原因 |
|---|---|
| HTTP 400 + 未知参数 | 检查是否被注入了 `enable_thinking` / `reasoning_effort`（本项目已规避） |
| `status_code: 1039` | 模型名不存在或账号无权限，去开放平台「模型广场」确认已开通 |
| `status_code: 1004` | API Key 无效 / 过期 |

---

## 3. 图片通道（`src/services/adapters/minimax-image.ts`）

### 3.1 请求

```jsonc
POST {base}/v1/image_generation
{
  "model": "image-01",
  "prompt": "……",              // 1~1500 字符
  "n": 1,
  "response_format": "url",     // url | base64
  "prompt_optimizer": false,
  "width": 1920, "height": 1080 // 或改用 aspect_ratio
}
```

- **尺寸映射**：项目侧的 `size`（形如 `1920x1080`）落在官方区间（512~2048 且为 8 的倍数）时
  转成 `width`/`height`；否则退化为 `aspect_ratio`（默认 `16:9`）。
- **参考图（角色一致性）**：`subject_reference: [{ type: "character", image_file: "<公网URL>" }]`。
  官方只支持 1 张，且**必须是公网可访问的 http(s) URL**——内联 `data:` URL 会被上游拒绝。
  传本地路径时后端会用 `PUBLIC_BASE_URL` 拼成公网地址；未配置 `PUBLIC_BASE_URL` 会给出
  可操作的错误提示而不是一句「任务失败」。
- **`image-01-live` 画风**：在 `image-01` 基础上额外支持 `style: { style_type }`，
  可选 `漫画` / `元气` / `中世纪` / `水彩`。工作台顶栏在选中 `image-01-live` 时
  会出现「画风」下拉，选择后随生图请求一起下发。
  给 `image-01`（不支持画风）传画风会得到明确报错而不是被上游静默忽略。

### 3.2 响应

同步返回，没有异步任务：

```jsonc
{
  "id": "trace-id",
  "data": { "image_urls": ["https://…"], "image_base64": [] },
  "metadata": { "success_count": "1", "failed_count": "0" },
  "base_resp": { "status_code": 0, "status_msg": "success" }
}
```

---

## 4. 视频通道（`src/services/adapters/minimax-video.ts`）

同一个适配器按模型族自动选择两代接口。

### 4.1 v2（H3 全模态系列）

```
提交: POST {base}/v2/video_generation
      { model, content: [ {type:'text',text}, {type:'image_url',role:'first_frame'|'last_frame'|'reference_image'},
                           {type:'video_url',role:'reference_video'}, {type:'audio_url'} ],
        duration: 4~15, resolution: '768P'|'2K', ratio: '16:9'|… }
轮询: GET  {base}/v2/query/video_generation/{task_id}
      { task: { status:'succeeded'|'failed'|'processing', content:{url}, error, duration } }
```

- 有首帧图（图生视频）时官方要求 **省略 `ratio`**（恒为 adaptive）；文生视频 `ratio` 必填。
- 参考素材上限：图片 ≤9、视频 ≤3、音频 ≤3，混合总数 ≤12。
- 提示词 ≤7000 字符。

### 4.2 v1（经典 Hailuo 系列）

```
提交: POST {base}/v1/video_generation
      { model, prompt, duration: 6|10, resolution: '720P'|'768P'|'1080P',
        prompt_optimizer, first_frame_image, last_frame_image, subject_reference }
轮询: GET  {base}/v1/query/video_generation?task_id=…
      { task_id, status: 'Queueing'|'Preparing'|'Processing'|'Success'|'Fail', file_id }
取件: GET  {base}/v1/files/retrieve?file_id=…
      { file: { download_url } }
```

v1 成功后**只有 `file_id`**，需要再调一次 `/v1/files/retrieve` 换下载地址。
适配器通过新增的可选钩子 `resolveVideoUrl()` 完成这一步，
`generation.ts` 在判定 `completed` 后统一调用。

### 4.3 模型能力矩阵（参数按模型档案归一化）

H3 家族与 Hailuo 家族的分辨率 / 时长 / 参考素材限制差别很大，
硬编码一套参数会在很多组合上直接被上游 400。
因此适配器用 `minimax-common.ts` 里的**模型能力档案**逐个归一化：

| 模型 | 分辨率 | 时长 | 首帧 | 尾帧 | 参考素材 |
|---|---|---|---|---|---|
| `MiniMax-H3` | 768P / 2K | 4–15s | ✅ | ✅ | ✅ |
| `MiniMax-H3-Highspeed` | 仅 768P | 4–15s | ✅ | ✅ | ✅ |
| `MiniMax-H3-Lite` | 480P / 768P | 4–15s | ✅ | ✅ | ✅ |
| `MiniMax-H3-Max` | 480P / 768P | 5–15s | ✅ | ✅ | ✅ |
| `MiniMax-H3-Max-Turbo` | 480P / 768P | 5–15s | ✅ | ✅ | ❌ |
| `MiniMax-Hailuo-2.3` | 768P / 1080P | 6s、10s（768P） | 可选 | ❌ | — |
| `MiniMax-Hailuo-2.3-Fast` | 768P / 1080P | 6s、10s（768P） | **必填** | ❌ | — |
| `MiniMax-Hailuo-02` | 512P / 768P / 1080P | 6s、10s（512P/768P） | 可选 | ✅ | — |
| `T2V/I2V/S2V-01`、`Video-01` | 720P | 6s | I2V 必填 | ❌ | S2V 用 `subject_reference` |

几个由此修掉的真实问题：

- **720P 不是 Hailuo-2.3 的合法档位**。项目侧只存 `480p` / `720p`，
  旧实现把 `720p` 原样发成 `720P`，Hailuo-2.3 会被上游拒绝。
  现在按候选链映射到该模型实际支持的档位（`720p` → `768P`）。
- **首尾帧插值只有 `MiniMax-Hailuo-02` 支持**。旧实现对所有 v1 模型都发
  `last_frame_image`，Hailuo-2.3 / Hailuo-02 之外的模型会报错。
  现在非支持模型直接给出「请改用 MiniMax-Hailuo-02」的明确提示。
- **`Hailuo-2.3-Fast` 与 `I2V-01` 系列必须带首帧图**，缺图时在本地就报清楚原因。
- **10 秒只在 768P / 512P 可用**：请求 1080P + 10s 时自动降为 6s，保持参数组合合法。
- **`aigc_watermark`** 与项目已有的「水印」开关打通。

### 4.4 交付恢复

只有 v2 链路支持「交付恢复」（`POST {base}/v2/query/video_generation/{task_id}/recover`），
由适配器的可选方法 `buildRecoveryRequest()` 声明；
v1 模型会明确抛出「当前模型不支持交付恢复」而不是拼一个错误 URL。

---

## 5. 真实连通性测试

### 5.1 与旧版 probe 的区别

旧版 `POST /ai-configs/test` 只发一个**空请求**看端点是否可达，
结果只有「端点已响应 / 未按预期响应」，无法区分鉴权、参数、额度、审核等真实原因。

新版 `src/services/ai-connection-test.ts` 做的是**真实调用**：

| 服务类型 | 真实动作 | 成功判定 |
|---|---|---|
| 文本 | 发一次最小 Chat Completion（`ping`） | 解析到非空文本内容 |
| 图片 | 真实生成 1 张图（最短提示词、`n=1`、关闭 prompt 优化） | 拿到 `image_urls` / `image_base64` |
| 视频 | 真实提交 1 个任务并短轮询（默认 ≤90s） | 拿到 `task_id`（Success / 处理中均视为通道可用，Fail 则如实报错） |

同时保留 `mode: 'light'`：**只探测端点可达性，不调用模型、不产生计费**。

### 5.2 返回结构

```jsonc
{
  "ok": true,                  // 真实调用是否成功
  "reachable": true,           // 端点是否有响应（兼容旧前端字段）
  "service_type": "image",
  "provider": "minimax",
  "model": "image-01",
  "status": 200,               // HTTP 状态码
  "stage": "success",          // config | auth | quota | request | response | poll | success
  "message": "真实生图成功，模型返回了图片",
  "method": "POST",
  "url": "https://api.minimaxi.com/v1/image_generation",
  "latency_ms": 4210,
  "response_preview": "…",
  "detail": { "image_url": "https://…" },
  "suggestion": "…",           // 失败时的可操作建议
  "provider_code": 1039,       // 厂商业务错误码
  "provider_message": "…",
  "key_type": "subscription"   // 仅 MiniMax：subscription | payg | unknown
}
```

`stage` 与 `suggestion` 的判定依据：
- HTTP 401/403 → `auth`（鉴权/模型权限）
- HTTP 404 → `config`（Base URL 或版本路径错误）
- HTTP 429 / 402 → `quota`（限流 / 额度不足，402 会按 Key 类型分流建议）
- HTTP 200 但 `base_resp.status_code != 0` → `response`（厂商业务错误，附错误码与中文建议）

MiniMax 专属：`stage` 判定完成后还会跑一遍 `applyMiniMaxPlanHint()`，
按 Key 类型修正「余额不足 / 额度用尽」这类容易误导的建议，
并在订阅 Key 调用超出套餐范围的模型时补上套餐层面的说明。

MiniMax 错误码对照表见 `src/services/adapters/minimax-common.ts` 的 `CODE_HINTS`。

---

## 6. 失败详情

### 6.1 数据结构

任务失败时，除了 `sys_task.error_msg`（一句话摘要）之外，新增
`sys_task.error_detail`（JSON，DDL 幂等重放 + `ALTER TABLE` 补列）：

```jsonc
{
  "stage": "response",         // 失败环节
  "message": "内容被安全审核拦截",
  "httpStatus": 200,
  "providerCode": 1026,
  "providerMessage": "content moderation failed",
  "requestUrl": "https://api.minimaxi.com/v1/image_generation",
  "requestBody": { "model": "image-01", "prompt": "…" },
  "responseBody": { "base_resp": { … } },
  "hint": "内容被安全审核拦截，请调整提示词后重试",
  "provider": "minimax",
  "model": "image-01",
  "upstreamTaskId": "1234567890",
  "at": "2026-10-26T12:00:00.000Z"
}
```

所有写库的请求体 / 响应体都会经过 `redactSecrets()` + `previewBody()`：
密钥、Bearer、签名被替换为 `[redacted]`，base64 与超长字段被截断。

### 6.2 采集点

| 位置 | 捕获内容 |
|---|---|
| 提交阶段 HTTP 非 2xx | 状态码 + 响应原文 + 请求体摘要 |
| 适配器抛 `ProviderError` | 厂商错误码 + 错误原文 + 响应体 + 建议 |
| 轮询判定失败 | 上游任务号 + 轮询响应体 |
| 轮询超时 / 次数用尽 | 上游任务号 + 最后一次 HTTP 状态 |
| 结果下载失败 | 交付阶段标记 + 恢复建议 |

### 6.3 查看方式

- 工作台「任务」抽屉 → 失败行上的 **「查看失败详情」** 按钮 → 弹窗展示
  失败环节 / HTTP 状态 / 厂商错误码 / 上游任务号 / 请求地址 / 请求参数 / 响应内容 / 排查建议，
  支持一键复制。
- `GET /api/v1/tasks/:id/diagnostics` 同时返回 `errorDetail` 字段（原有字段保持不变）。

---

## 7. 订阅套餐（Token Plan / M Plan）

### 7.1 两种互斥的凭证

MiniMax 开放平台签发两类 Key，**请求格式完全相同**（都是 `Authorization: Bearer <key>`，
走同一批端点），区别只在「扣谁的钱」和「模型覆盖范围」：

| Key 类型 | 前缀 | 扣费来源 | 备注 |
|---|---|---|---|
| 按量计费 API Key | `sk-api` | 账户余额 | 支持全部模型，H3 只能走这条 |
| 订阅 Key | `sk-cp` | 套餐额度 → 积分包（**不扣账户余额**） | 只覆盖套餐内模型 |

**最常见的踩坑**：用 `sk-api` 去跑本该走套餐额度的场景，套餐额度纹丝不动，
余额却几分钟被扣光；反过来用 `sk-cp` 跑超出套餐范围的模型，则直接被拒。

因此接入侧的做法是：**请求格式完全按官方契约走，但失败诊断按 Key 类型分开归因**。

### 7.2 额度窗口

- 文本 / 图片 / 语音等**非视频**模型：受 **5 小时窗口** 与 **周窗口** 双重约束
- **视频模型只受周窗口约束**（等 5 小时刷新不会恢复视频额度）
- 两个窗口从首次使用开始计时、各自独立刷新，额度不结转到下个周期

### 7.3 额度查询

官方给出 `GET {base}/v1/token_plan/remains`（老路径 `/v1/coding_plan/remains`），
**只有订阅 Key 能查**。本项目在 `src/services/adapters/minimax-plan.ts` 里做了：

- 端点与响应体归一化（`data` 包裹 / 顶层两种形态都支持）
- 5 小时窗口、周窗口、模型明细统一成 `total / used / remaining / percentRemaining / resetTime`
- 接口： `POST /ai-configs/plan-quota` → 前端「设置 → AI 服务 → 订阅套餐额度 → 查询额度」

用按量 Key 去查会拿到 1004/401 —— 这本身也是有价值的诊断信息：
说明用户填错了 Key 类型，提示会直接指出「该 Key 是按量计费 Key，不能查询订阅额度」。

### 7.4 套餐覆盖范围

| 模型 | 旧版 Token Plan | M Plan Go | M Plan Explore / Build |
|---|---|---|---|
| 文本（`MiniMax-M3` 等） | ✅ | ✅ | ✅ |
| 图片（`image-01` / `image-01-live`） | ✅ | ✅ | ✅ |
| Hailuo 系列视频 | ✅ | ❌ | ✅ |
| **H3 系列视频** | **❌** | ❌ | ✅（仅扣周窗口） |

> H3 的 v2 接口需要按量付费，或使用含视频模型的 M Plan 档位；
> 另外「视频资源包」只覆盖 Hailuo 系列，**不覆盖 H3**。

当订阅 Key 调用 H3 失败时，失败详情会直接给出这条说明，
而不是含糊的「模型无权限」。

### 7.5 订阅相关错误码

| 错误码 | 含义 | 本项目的建议 |
|---|---|---|
| `2056` | 订阅额度窗口已用尽 | 等待窗口重置 / 购买积分包 / 改用按量计费 Key（并说明视频只受周窗口约束） |
| `2062` | 没有生效的订阅计划 | 去「订阅管理」确认套餐已生效 |
| `1008` | 余额或额度不足 | 按 Key 类型分流：订阅 Key → 套餐额度用尽；按量 Key → 账户余额不足 |

---

## 8. 使用建议

1. **先测再存**：在「设置 → AI 服务」里填好 Base URL / API Key / 模型，点「真实测试」，
   看到绿色的「测试通过」再保存，避免保存了一个根本调不通的配置。
2. **图片/视频真实测试会计费**：只想验证地址与鉴权时用「轻量探测」。
3. **MiniMax 参考图需要公网地址**：给 MiniMax 配参考图前，先在 `backend/.env` 里设置
   `PUBLIC_BASE_URL`，否则会明确提示「MiniMax 参考图需要公网可访问的图片 URL」。
4. **视频任务的失败可恢复**：上游已生成但下载失败时，任务会标成 `delivery_failed`，
   点「恢复视频」重试下载即可，不会重复计费；只有 `generation_failed` 才需要重新生成。
5. **先分清 Key 类型再选模型**：填的是订阅 Key（`sk-cp`）时，注意 H3 需要 M Plan
   Explore / Build 档位；设置页会实时识别 Key 类型并给出对应提示，
   也可以直接点「查询额度」看 5 小时窗口与周窗口的剩余量。
