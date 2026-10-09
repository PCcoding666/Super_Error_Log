# 手机接口说明（/v2，v2.0）

读者：iPhone 客户端工程师。本文逐项对照 `src/v2/router.ts` 与各 service 写成；字段名、状态码、文案以代码为准。
上传与识别进度接口（`POST /v1/recognitions`、`GET /v1/recognitions/:id`）见 `docs/mobile-recognition-api.md`，本文不重复。

## 1. 总则

### 1.1 服务与鉴权

`/v2` 与 `/v1` 挂在同一移动服务进程上（回环默认 `127.0.0.1:3101`），鉴权由挂载方统一施加，`/v2` 路由器本身不再鉴权：

- **回环模式**：共享令牌。每个请求（含 `/v2/health`、图片）都带
  `Authorization: Bearer <SEL_MOBILE_PAIRING_TOKEN>`。
  令牌缺失或不符：`401 {"error":{"code":"unauthorized","message":"本地配对令牌无效。"}}`。
- **云端模式**：设备令牌（`POST /v1/pairing/redeem` 兑换，见 v1 文档）。
  鉴权失败 `401 {"error":{"code":"unauthorized","message":<配对错误文案>}}`。

### 1.2 限流（仅云端模式）

每分钟滚动窗口，超限返回 `429 {"error":{"code":"rate_limited","message":"请求过于频繁，请稍后再试。"}}` 并带 `Retry-After`（秒）响应头：配对失败每来源 IP 10 次 + 全局 60 次；鉴权失败每来源 IP 30 次；已鉴权查询每设备 300 次。回环模式不限流。

### 1.3 错误信封

所有业务错误统一为：

```json
{ "error": { "code": "invalid_request", "message": "请求正文不合法。" } }
```

`code` 取值：`unauthorized` / `rate_limited` / `invalid_request`（400）/ `not_found`（404）/ `conflict`（409）/ `bad_gateway`（502）。
**例外**：三个修改接口（`/items/:id/correct*`）在因 revision 冲突等原因返回 409 时，顶层额外带当前 `revision`（与 `error` 同级，不在 `error` 内）：

```json
{ "error": { "code": "conflict", "message": "识别结果已更新，请重新加载。" }, "revision": 3 }
```

### 1.4 日期与时间格式

- 服务器时间戳一律 ISO 8601 UTC 字符串（如 `2026-09-30T08:15:00.123Z`）：`registeredAt`、`createdAt`、`generatedAt`、`preparedAt` 等。
- 回传入参 `performedOn` 是纸上实际作答的**本地日历日**，格式 `YYYY-MM-DD`。
- 回报里的 `nextConfirmOn` 只含日期 `YYYY-MM-DD`。
- `week` 是 ISO 周键 `YYYY-Www`（如 `2026-W40`），按登记时间（`registered_at`）所在周划分。

### 1.5 媒体接口

`cropUrl`（`/v2/items/:id/crop`）与打印快照图片（`/v2/practice/:id/print/media/:name`）都返回 `image/jpeg`，同样需要 `Authorization` 头；响应带 `Cache-Control: private, no-store`。所有响应（全应用层）都带 `cache-control: private, no-store` 与 `pragma: no-cache`。

### 1.6 协议版本

`GET /v2/health` → `200 {"protocolVersion":2}`（回环模式同样需要令牌）。

## 2. 上传与登记的顺序

1. `POST /v1/recognitions` 上传照片，拿 `job.id`（见 v1 文档）。
2. `GET /v1/recognitions/:id` 轮询识别进度，直到 `status` 为 `completed` / `partial`（终态）。
3. **勾选（v2.1a 起）**：找题后只有带批改痕迹的题被精读；没有痕迹的题是 `unselected`（未精读、不计费）。若还有要收入错题本的题，用 `GET /v1/recognitions/:id/questions/:questionId/candidate` 取候选缩略图给学生看，学生确认后 `POST /v1/recognitions/:id/select` 勾选——任务会回到 `processing`，再次轮询到终态。重复勾选幂等；不勾的题永不精读。
4. `POST /v2/photos/:jobId/register` 登记该任务进入学习闭环。
5. `GET /v2/week`：调用时服务器先做"懒桥接"（把已登记、已到终态的任务转成错题），随后本周登记照片桥接出的题出现在 `items`，以往周登记且待处理（`ready_for_reflection` / `eligible_for_review` / `needs_recheck`）的题出现在 `backlog`。勾选后新增的题在下一次 `GET /v2/week` 时补入。

未登记的任务永不进入学习记录；重复登记幂等。

## 3. 接口逐项说明

ID 形态：题目 `itm_<16位hex>`，练习包 `pkt_<16位hex>`，复盘 `dia_<16位hex>`，修改建议 `crp_<16位hex>`；`jobId` 与 `clientRequestId` 是 UUID。

### 3.1 `POST /v2/photos/:jobId/register` — 登记照片

无请求正文。`jobId` 必须是 UUID 且任务目录存在，否则 `404 not_found` `识别任务不存在。`
幂等：重复登记返回相同结果。

```json
{ "jobId": "3f7b69dc-9d37-4aaa-b965-bb61243445a0", "registeredAt": "2026-09-30T08:15:00.123Z" }
```

### 3.2 `GET /v2/week` — 本周错题卡片

调用即触发懒桥接（单个任务桥接失败不影响返回，错误落在该照片的 `bridgeError`）。

```json
{
  "week": "2026-W40",
  "photos": [
    {
      "jobId": "3f7b69dc-9d37-4aaa-b965-bb61243445a0",
      "registeredAt": "2026-09-30T08:15:00.123Z",
      "recognition": "done",
      "bridged": true,
      "bridgeError": null,
      "itemCount": 3,
      "unselectedCount": 2
    }
  ],
  "items": [
    {
      "id": "itm_0a1b2c3d4e5f6071",
      "shortId": "M-12",
      "subject": "数学",
      "knowledgeTags": ["一元一次方程"],
      "questionExcerpt": "已知 x+y=1，求 x 的值。",
      "badge": "ok",
      "status": "ready_for_reflection",
      "cropUrl": "/v2/items/itm_0a1b2c3d4e5f6071/crop",
      "jobId": "3f7b69dc-9d37-4aaa-b965-bb61243445a0"
    }
  ],
  "backlog": []
}
```

- `recognition`：`processing` / `done` / `failed`（读移动任务本身：终态 `completed`/`partial` 为 `done`，`failed` 为 `failed`，其余含不可读为 `processing`）。
- `bridged`：已桥接且无桥接错误；`bridgeError` 为桥接失败原因（如 `job_unreadable`、`duplicate_source:<jobId>`、`source_media_missing`）。
- `unselectedCount`（v2.1a 起）：该任务当前还在等学生勾选（`unselected`）的题数；任务读不到时为 0。大于 0 时客户端应提示学生去勾选面板看一眼。
- 被标记"不是错题"的题从 `items` 消失；`backlog` 是往周登记且仍在候选状态的题。

### 3.3 `GET /v2/items/:id/crop` — 整题裁图

查询参数 `scope`（可选）：

- 缺省或 `question`：题干裁图（识别阶段的题目区域），卡片缩略用。
- `full`：整题大图——题目区域与该题全部证据区域（学生作答、订正、批注、参考答案、图示等）的并集外扩，**不遮白**。题目详情与"不对，改一下"修改面板用，供学生核对自己的手写识别结果。
- 其他值：`400 invalid_request` `scope 只能是 question 或 full。`

`200 image/jpeg`。非 v2 来源或不存在：`404 not_found` `题目不存在或不属于手机上传。`；裁图不可读：`404 not_found` `整题裁图无法读取。`

### 3.4 `POST /v2/items/:id/discard` — 不是错题

无请求正文。成功 `200 {"id":"itm_…","status":"archived_not_worth_review"}`。

- `404 not_found` `题目不存在或不属于手机上传。`
- `409 conflict` `当前状态不能标记为"不是错题"。`（仅 `ready_for_reflection` / `eligible_for_review` 可标记）
- `409 conflict` `该题已在未回传的练习包中，请先完成练习回传。`

### 3.5 `POST /v2/items/:id/restore` — 恢复

无请求正文。成功 `200 {"id":"itm_…","status":"ready_for_reflection"}`（有复盘则 `"eligible_for_review"`）。

- `404 not_found` `题目不存在或不属于手机上传。`
- `409 conflict` `该题不在"不是错题"状态，无法恢复。`

### 3.6 `GET /v2/settings` — 学生设置

`200 {"practiceSlot":"本周内","paperLocation":"varies"}`（未设置过时为默认值）。

### 3.7 `PUT /v2/settings` — 更新设置

正文（两个字段都必填）：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `practiceSlot` | string | 1–20 字 |
| `paperLocation` | string | `school` / `home` / `varies` |

成功 `200` 回显新设置。错误（均 `400 invalid_request`）：`请求正文不合法。` / `practiceSlot 必须是 1–20 字的字符串。` / `paperLocation 只能是 school / home / varies。`

### 3.8 `GET /v2/practice/recommend` — 本周推荐

不调用模型，纯规则。候选：v2 来源、状态在候选集内、未归档、不在未回传练习包里的题。

```json
{
  "recommended": [
    {
      "id": "itm_0a1b2c3d4e5f6071",
      "shortId": "M-12",
      "subject": "数学",
      "knowledgeTags": ["一元一次方程"],
      "questionExcerpt": "已知 x+y=1，求 x 的值。",
      "badge": "ok",
      "status": "ready_for_reflection",
      "cropUrl": "/v2/items/itm_0a1b2c3d4e5f6071/crop",
      "jobId": "3f7b69dc-9d37-4aaa-b965-bb61243445a0",
      "reason": "本周新错题",
      "tier": 4,
      "reflected": false
    }
  ],
  "others": [],
  "notes": ["本周可安排题目仅 3 道，不足 5 道，已全部纳入"],
  "limits": { "min": 5, "max": 8 }
}
```

`tier` 与 `reason` 的对应见 §4。候选不足 5 道时全部入选且 `notes` 含提示；同知识点最多 2 道（为满足最低题量可放宽，此时 `notes` 说明）。

### 3.9 `POST /v2/practice` — 建练习

正文：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `itemIds` | string[] | 必填，1–8 个、不重复、全部在当前候选集内 |
| `practiceSlot` | string | 可选，1–20 字；缺省用学生设置里的 `practiceSlot` |

成功 `200` 返回练习详情（形状同 3.11，建包时 `status` 为 `scheduled`、`generatedAt` 为 `null`，`items` 带 `position` 从 0 递增）。复盘不是建包前提。错误：

- `400 invalid_request`：`请求正文不合法。` / `itemIds 必须是非空的题目 ID 数组。` / `题目不能重复。` / `一次练习最多 8 道。` / `practiceSlot 必须是 1–20 字的字符串。`
- `409 conflict`：`以下题目当前不可安排：<id>、<id>`（含非 v2 题、已归档题、已在未回传包里的题）

### 3.10 `GET /v2/practice` — 练习列表

`200 {"packets":[…]}`：最近 8 个含 v2 题的练习包摘要，新的在前。

```json
{
  "packets": [
    {
      "id": "pkt_1a2b3c4d5e6f7081",
      "week": "2026-W40",
      "status": "scheduled",
      "practiceSlot": "周三晚自习",
      "createdAt": "2026-09-30T08:20:00.000Z",
      "generatedAt": null,
      "itemCount": 3
    }
  ]
}
```

### 3.11 `GET /v2/practice/:id` — 练习详情

仅限含 v2 题的包，否则 `404 not_found` `练习不存在。`

```json
{
  "id": "pkt_1a2b3c4d5e6f7081",
  "week": "2026-W40",
  "status": "scheduled",
  "practiceSlot": "周三晚自习",
  "createdAt": "2026-09-30T08:20:00.000Z",
  "generatedAt": null,
  "items": [
    {
      "id": "itm_0a1b2c3d4e5f6071",
      "shortId": "M-12",
      "subject": "数学",
      "knowledgeTags": ["一元一次方程"],
      "questionExcerpt": "已知 x+y=1，求 x 的值。",
      "badge": "ok",
      "status": "scheduled",
      "cropUrl": "/v2/items/itm_0a1b2c3d4e5f6071/crop",
      "jobId": "3f7b69dc-9d37-4aaa-b965-bb61243445a0",
      "reason": "本周新错题",
      "tier": 4,
      "reflected": false,
      "position": 0
    }
  ]
}
```

`tier`/`reason` 是建包时冻结的推荐层级与理由，之后状态变化不影响显示。

### 3.12 `POST /v2/practice/:id/print` — 请求打印快照

无请求正文。**异步**：服务器冻结"结构化内容 + 图片"，PDF 由手机排版生成。幂等：

- 首次（或上次 `failed` 重试）：`202 {"status":"preparing"}`，后台开始准备。
- 已在准备：`200 {"status":"preparing"}`。
- 已就绪：`200 {"status":"ready","snapshot":{…}}`（同一份快照，之后对题目的任何修改都不影响它）。
- 包不存在或非 v2 包：`404 not_found` `练习不存在。`

### 3.13 `GET /v2/practice/:id/print` — 打印快照状态/轮询

```json
{ "status": "preparing", "progress": { "done": 1, "total": 3 } }
```

- `status`：`none`（未请求过）/ `preparing` / `ready` / `failed`（此时另带 `error` 字符串）。
- `ready` 时另带 `snapshot`（形状见下）。`404 not_found` `练习不存在。`

快照形状（手机据此排版）：

```json
{
  "packetId": "pkt_1a2b3c4d5e6f7081",
  "week": "2026-W40",
  "preparedAt": "2026-09-30T08:21:00.000Z",
  "cover": {
    "title": "本周练习",
    "practiceSlot": "周三晚自习",
    "rules": ["不看答案，独立做", "卡住先看一级提示，再看二级", "做完打勾，写上做题日期"],
    "itemList": [{ "shortId": "M-12", "sourceLabel": "原题" }]
  },
  "items": [
    {
      "itemId": "itm_0a1b2c3d4e5f6071",
      "shortId": "M-12",
      "position": 0,
      "subject": "数学",
      "knowledgeTags": ["一元一次方程"],
      "mode": "text",
      "stemText": "已知 x+y=1，求 x 的值。",
      "cropMedia": null,
      "diagramMedia": [],
      "keyStepPrompt": "这题的关键一步是：",
      "checkboxes": ["独立做出", "看了一级提示", "看了二级提示", "没做出来"],
      "needsGlance": false,
      "glanceReason": null
    }
  ],
  "answerSheet": [
    {
      "shortId": "M-12",
      "hint1": "一级提示：先移项",
      "hint2": "二级提示：两边同时减 y",
      "answer": { "text": "x = 1 - y", "source": "ai", "label": "AI 参考，未经老师核验" },
      "fallbackNote": "对照原卷第 1 题"
    }
  ]
}
```

- `mode`：`text` 印 `stemText`（`requiresDiagram` 时另附 `diagramMedia` 图片）；徽标 `low` 或需要图示但无图示区域时印遮白裁图 `cropMedia`（题面上的作答/订正/批注/参考答案已遮白）。`crop` 模式下 `stemText` 同样是识别出的题干文字（不是 `null`）——截图有问题时学生还有文字，文字有问题时还有截图；排版时在文字旁标注"AI 对这题没把握，以截图为准"。
- `answer.source`：`paper`（原卷参考答案，`label` `原卷参考答案`）/ `ai`（coach 答案，`label` `AI 参考，未经老师核验`）/ `none`（`text`/`label` 为 `null`）。
- `fallbackNote` 随设置里 `paperLocation`：`school` → `对照原卷第 N 题`；`home` → `回家后对照原卷第 N 题`；`varies` → `对照原卷第 N 题（原卷不在手边就回家再对）`。`N` 是规整后的题号：去掉首尾空白、结尾的 `.．、。:：)）` 与"题"、开头的 `(（` 与"第"（如 `"2."`→`第 2 题`、`"（3）"`→`第 3 题`）；规整后为空则用原值。
- `needsGlance` 见 §6。

### 3.14 `GET /v2/practice/:id/print/media/:name` — 快照图片

`200 image/jpeg`。`name` 只能是快照里登记过的 `cropMedia` / `diagramMedia` 文件名（形如 `p2-crop.jpg`），否则 `404 not_found` `快照图片不存在。`

### 3.15 `POST /v2/practice/:id/return` — 回传

正文 `results` 为 1–8 条数组，每条：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `itemId` | string | 必填，非空 |
| `completion` | string | `independent` / `hint1` / `hint2` / `not_solved` / `not_done` |
| `correct` | boolean | `independent`/`hint1`/`hint2` 必填；`not_solved`/`not_done` 只能缺省或 `false` |
| `performedOn` | string | 必填，`YYYY-MM-DD`，纸上实际作答日期 |
| `stuckStep` | string | 可选 |

形状不合法整条请求 `400 invalid_request`（文案如 `results 必须是 1–8 条的数组。`、`completion 必须是 independent/hint1/hint2/not_solved/not_done 之一。`、`performedOn 必须是 YYYY-MM-DD 文本（纸上实际作答日期）。`、`独立做出或看了提示时，必须给出布尔值 correct。`、`没做出来/没做的题，correct 只能缺省或为 false。` 等），且不产生任何回传记录。
包不存在或非 v2 包：`404 not_found` `练习不存在。`

形状合法时 `200 {"results":[…]}`，**逐条独立判定**（某条被拒不影响其他条），支持分批回传：

```json
{
  "results": [
    { "itemId": "itm_0a1b2c3d4e5f6071", "ok": true, "toStatus": "temporarily_mastered", "reason": "延迟 3–7 天独立做对，进入暂时掌握" },
    { "itemId": "itm_1111111111111111", "ok": false, "error": "实际作答日期不能是未来日期" }
  ]
}
```

`ok:false` 时 `error` 为中文原因，常见的有：`复习包尚未生成 PDF，不能回传` / `该复习包已全部回传` / `该题在此复习包中已回传，确认轮请等下个复习包` / `该题不在此复习包中` / `实际作答日期不能是未来日期` / `实际作答日期不能早于复习包首次打印日期` / `状态「<status>」不可回传`。

### 3.16 `GET /v2/practice/:id/summary` — 回报

仅限 v2 包，否则 `404 not_found` `练习不存在。`

```json
{
  "answered": 3,
  "total": 3,
  "independentCorrect": 1,
  "masteredNow": [ { "id": "itm_0a1b2c3d4e5f6071", "shortId": "M-12", "subject": "数学", "knowledgeTags": ["一元一次方程"], "questionExcerpt": "已知 x+y=1，求 x 的值。", "badge": "ok", "status": "temporarily_mastered", "cropUrl": "/v2/items/itm_0a1b2c3d4e5f6071/crop", "jobId": "3f7b69dc-9d37-4aaa-b965-bb61243445a0" } ],
  "again": [ { "id": "itm_1111111111111111", "shortId": "M-13", "subject": "数学", "knowledgeTags": ["分式"], "questionExcerpt": "…", "badge": "ok", "status": "needs_recheck", "cropUrl": "/v2/items/itm_1111111111111111/crop", "jobId": "3f7b69dc-9d37-4aaa-b965-bb61243445a0", "reason": "看了提示" } ],
  "pending": [ { "id": "itm_2222222222222222", "shortId": "M-14", "subject": "数学", "knowledgeTags": ["一元一次方程"], "questionExcerpt": "…", "badge": "ok", "status": "attempted", "cropUrl": "/v2/items/itm_2222222222222222/crop", "jobId": "3f7b69dc-9d37-4aaa-b965-bb61243445a0", "reason": "当天做对，隔几天再独立做对才算掌握" } ],
  "calibration": {
    "confidentTotal": 1,
    "missedCount": 0,
    "text": "你说有把握的 1 道里，0 道没独立做出来",
    "items": []
  },
  "nextConfirmOn": "2026-10-10"
}
```

- `masteredNow`：本包已回传且进入暂时/稳定掌握的题卡片（形状同 `/v2/week` 的 item）。
- `again`：状态为 `needs_recheck` 的题卡片，附 `reason`（`看了提示` / `没做出来` / `没做` / `做错`，无回传记录时为 `需再做一次`）。
- `pending`：本包已回传、独立且做对、当前状态为 `attempted` 的题卡片（当天做对不算掌握），附固定 `reason` `当天做对，隔几天再独立做对才算掌握`；无则为空数组。`masteredNow` / `again` / `pending` 三组互不重叠。
- `calibration`：本包已回传且最近一次复盘把握 ≥2 的题里没独立做对的统计；基数为 0 时 `text` 为 `null`。
- `nextConfirmOn`：本包新进入暂时掌握的题中最早的确认日期（`YYYY-MM-DD`，仅日期），无则 `null`。

### 3.17 `POST /v2/items/:id/reflection/ask` — 发起/续取追问

无请求正文。成功 `200 {"turn":1,"question":"你原来写 x=1，这一步当时是怎么想的？","source":"ai"}`。
幂等：已有未回答的问题时原样返回，不再调用模型。证据里没有学生作答/订正时不调模型，直接返回固定开放句 `这题你当时卡在哪一步？`（`source` 为 `fallback`）；该题由学生自己勾入（答案写在答题卡上、卷面干净）且证据里没有学生作答/订正时，固定句改为 `这道题你当时是怎么做的？答案写的什么？`；模型调用失败按同一规则退回固定句。

- `404 not_found` `题目不存在或不属于手机上传。`
- `409 conflict` `追问已结束（最多两轮），请提交复盘。`

### 3.18 `POST /v2/items/:id/reflection/answer` — 回答追问并归纳

正文 `{"answer":"我以为移项不用变号，直接就抄过来了"}`（1–300 字）。成功：

```json
{
  "turn": 1,
  "summary": "把移项当成了照抄，漏了变号",
  "suggestedCause": "推理步骤",
  "suggestedAttemptState": "方法基本正确但步骤出错",
  "secondQuestion": "等号另一边你是怎么处理的？"
}
```

归纳失败时 `summary`/`suggestedCause`/`suggestedAttemptState` 为 `null`（学生手选）。`secondQuestion` 仅第 1 轮回答后且归纳给出时非空（它即第 2 轮问题）；第 2 轮回答后不再追问。

- `400 invalid_request` `回答需要 1–300 字。`
- `404 not_found` `题目不存在或不属于手机上传。`
- `409 conflict` `当前没有待回答的追问。`

### 3.19 `POST /v2/items/:id/reflection` — 提交复盘

全部由学生确认或修改后提交；AI 从不替学生提交。正文：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `attemptState` | string | 必填，`ATTEMPT_STATES` 之一（§4） |
| `cause` | string | 必填，`CAUSES` 之一（§4） |
| `masteryFeeling` | number | 必填，整数 0–3（§4） |
| `summary` | string | 可选，≤60 字；缺省时落最近一次 AI 归纳 |

成功 `200`：

```json
{
  "id": "dia_9f8e7d6c5b4a3210",
  "attemptState": "方法基本正确但步骤出错",
  "cause": "推理步骤",
  "masteryFeeling": 3,
  "summary": "把移项当成了照抄，漏了变号",
  "adoptedAi": true,
  "source": "v2",
  "createdAt": "2026-09-30T08:25:00.000Z",
  "status": "eligible_for_review"
}
```

`adoptedAi` 为 `true` 当且仅当 `attemptState` 与 `cause` 都等于最近一次 AI 建议。`status` 是复盘后的题目状态（`ready_for_reflection` 复盘后转 `eligible_for_review`，其余状态不变）。可重复提交（新记录覆盖式呈现，旧记录保留）。

- `400 invalid_request`：`做题状态不合法。` / `错因不合法。` / `把握程度需要 0–3。` / `归纳不超过 60 字。`
- `404 not_found` `题目不存在或不属于手机上传。`

### 3.20 `GET /v2/items/:id/reflection` — 复盘详情

仅学生端。`404 not_found` `题目不存在或不属于手机上传。`

```json
{
  "turns": [
    { "turn": 1, "question": "你原来写 x=1，这一步当时是怎么想的？", "source": "ai", "answer": "我以为移项不用变号，直接就抄过来了" }
  ],
  "suggestion": { "summary": "把移项当成了照抄，漏了变号", "suggestedCause": "推理步骤", "suggestedAttemptState": "方法基本正确但步骤出错" },
  "reflection": { "id": "dia_9f8e7d6c5b4a3210", "attemptState": "方法基本正确但步骤出错", "cause": "推理步骤", "masteryFeeling": 3, "summary": "把移项当成了照抄，漏了变号", "adoptedAi": true, "source": "v2", "createdAt": "2026-09-30T08:25:00.000Z" }
}
```

### 3.21 `GET /v2/items/:id/evidence` — 识别结果视图

供展示与键盘直改。`404 not_found` `题目不存在或不属于手机上传。`

```json
{
  "questionText": "已知 x+y=1，求 x 的值。",
  "subject": "数学",
  "knowledgeTags": ["一元一次方程"],
  "observations": [{ "id": "o1", "kind": "student_work", "text": "x=1" }],
  "badge": "ok",
  "revision": 1
}
```

`revision` 是修改接口的乐观并发依据：每次生效的修改 +1。

### 3.22 `POST /v2/items/:id/correct` — 生成修改建议（调用模型）

正文：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `instruction` | string | 必填，1–200 字 |
| `method` | string | 必填，`voice` / `keyboard` |
| `revision` | number | 必填，整数 ≥1，须等于当前证据 revision |
| `clientRequestId` | string | 必填，UUID；幂等键 |

成功 `200`：

```json
{
  "proposalId": "crp_a1b2c3d4e5f60718",
  "revision": 1,
  "changes": [
    { "field": "questionText", "before": "已知 x+y=1，求 x 的值。", "after": "已知 x+y=1，求 y 的值。", "find": "x 的值", "replace": "y 的值" }
  ],
  "clarify": null
}
```

`changes[].field` 取值 `questionText` / `observation`（此时带 `observationId`）/ `subject` / `knowledgeTags`（`after` 为 JSON 数组字符串）。`clarify` 是模型反问或被略过条目的原因拼接，可为 `null`。
幂等：同一 `clientRequestId` 重放返回同一结果（含失败的 502），不再调用模型、不占限流额度；`clientRequestId` 被别的题用过则 `409 conflict` `请求标识已被使用。`

错误：

- `400 invalid_request`：`修改指令需要 1–200 字。` / `修改方式不合法。` / `revision 不合法。` / `clientRequestId 须为 UUID。`
- `404 not_found`：`题目不存在或不属于手机上传。` / `没有可修改的识别结果。`
- `409 conflict` `识别结果已更新，请重新加载。`（顶层带当前 `revision`）
- `429 rate_limited` `这题改得太频繁了，请一小时后再试，或用键盘直接改。`（每题每小时最多 6 次实际模型调用，成功与失败都计入，重放不计）
- `502 bad_gateway` `这次没生成出可用的修改，请换个说法或用键盘直接改`（模型/校验失败，不重试；失败也落一条不可接受的记录）

### 3.23 `POST /v2/items/:id/correct/accept` — 接受建议

正文 `{"proposalId":"crp_…","revision":1}`（`revision` 须等于建议生成时的基准与当前值）。成功：

```json
{
  "revision": 2,
  "card": { "id": "itm_0a1b2c3d4e5f6071", "shortId": "M-12", "subject": "数学", "knowledgeTags": ["一元一次方程"], "questionExcerpt": "已知 x+y=1，求 y 的值。", "badge": "ok", "status": "ready_for_reflection", "cropUrl": "/v2/items/itm_0a1b2c3d4e5f6071/crop", "jobId": "3f7b69dc-9d37-4aaa-b965-bb61243445a0" }
}
```

生效规则：证据 revision +1；仅当本次修改含 `questionText` 时把徽标置为 `ok`；不改题目状态；逐条写修改记录。
错误（`code` 按状态码映射，409 时顶层可能带当前 `revision`）：

- `400 invalid_request`：`缺少 proposalId。` / `revision 不合法。`
- `404 not_found`：`题目不存在或不属于手机上传。` / `修改建议不存在。` / `没有可修改的识别结果。`
- `409 conflict`：`该建议未成功生成，无法接受。` / `该建议已被接受。` / `该建议已过期，请重新生成。`（建议 10 分钟内有效）/ `识别结果已更新，该建议已失效。`（带 `revision`）/ `该建议没有可接受的修改。` / 逐条校验被拒的原因拼接（带 `revision`）

### 3.24 `POST /v2/items/:id/correct/direct` — 键盘直改（不调模型）

正文 `{"revision":1,"changes":[…]}`，`changes` 形状同 3.22 的完整 `before`/`after` 形式（`before` 必须与当前值完全一致）。校验同接受建议：字段枚举、`subject` 枚举（`数学`/`物理`/`化学`）、`knowledgeTags` 为 1–5 个的 JSON 数组、同一字段只改一次；对 `student_work` 观察记录的改动幅度不得超过"原文 50% 且 20 字"（不许把学生原作的错误改对）。成功响应同 3.23。
错误：

- `400 invalid_request`：`revision 不合法。` / `修改内容不合法：<原因>` / 逐条被拒原因拼接（如 `<字段>的改前内容与当前识别结果不一致，已略过该条修改`）/ `没有可生效的修改。`
- `404 not_found`：`题目不存在或不属于手机上传。` / `没有可修改的识别结果。`
- `409 conflict` `识别结果已更新，请重新加载。`（顶层带当前 `revision`）

### 3.25 `GET /v2/corrections/report` — 修正即测量报告

只输出计数，不含任何题目文字（家长可见的聚合面）。

```json
{
  "weeks": [
    {
      "week": "2026-W40",
      "itemCount": 3,
      "fields": [
        { "field": "questionText", "corrected": 1, "total": 3, "rate": 0.3333333333333333 },
        { "field": "student_work", "corrected": 0, "total": 3, "rate": 0 }
      ],
      "notAMistake": { "count": 0, "rate": 0 },
      "manuallySelected": 2
    }
  ]
}
```

`fields[].field` 固定全集：`questionText` / `student_work` / `correction` / `teacher_note` / `reference_answer` / `subject` / `knowledgeTags`。`rate` 为 `corrected/total`（`total` 为 0 时 `rate` 为 0）。`notAMistake` 是该周被标"不是错题"的数量与占比。`manuallySelected`（v2.1a 起）是该周登记的照片里由学生手动勾入并已成为错题的数量——它与 `notAMistake` 一起反映批改痕迹判断的准确度。

### 3.26 `POST /v2/reflections/transcribe` — 一段录音转文字（2026-10-09）

给不能在手机上本地转写的客户端用（学生网页版；iOS App 仍在手机上转写）。正文是**原始录音字节**，`Content-Type` 为 `audio/mp4`（iOS Safari 的 `MediaRecorder` 产出的 AAC；也接受 `audio/x-m4a`、`audio/aac`）或 `audio/webm`（桌面浏览器测试用，可带 `;codecs=opus`）。

- 上限：≤ 5 MB；MP4 容器声明了时长（`mvhd` / 分片录音的 `mehd`）时还要 ≤ 60 秒。网页端录到 60 秒自动停。
- 成功 `200 {"text":"我以为移项不用变号，就直接抄过去了。"}`。没听出字时 `text` 为空串。文字不在服务器保存，由学生改完后作为 3.18 的 `answer` 自己提交。
- 错误：`415 unsupported_media_type` `只接受 audio/mp4 或 audio/webm 录音。` / `400 invalid_audio` `录音是空的，再说一次。` / `400 audio_too_long` `录音超过 60 秒，说短一点再试。` / `413 payload_too_large` `录音超过 5 MB 限制。` / `429 rate_limited` `说得太频繁了，过一会儿再试，或者直接打字。`（云端每设备每分钟 10 次，另计入 300 次的已鉴权查询）/ `502 bad_gateway` `这次没转成文字，再说一次，或者直接打字。`
- 模型：百炼 OpenAI 兼容接口 `chat/completions`，模型 `SEL_AI_MODEL_ASR`（缺省 `qwen3-asr-flash`），`messages[0].content = [{"type":"input_audio","input_audio":{"data":"data:audio/mp4;base64,…"}}]`，`asr_options: {"language":"zh","enable_itn":false}`。**录音不落盘、不写日志**。mock 模式固定返回上面那句合成文字，不发网络请求。
- 学生网页版用同源镜像 `POST /s/voice`（同一校验、同一转写器、同一限流档；鉴权是网页版的设备令牌 cookie，不是 `Authorization` 头）。

## 4. 枚举值全集

**题目状态 `ItemStatus`**（`status` 字段）：`captured`（已采集）/ `needs_review`（待校正）/ `ready_for_reflection`（待反思）/ `eligible_for_review`（可安排复习）/ `scheduled`（已安排）/ `packet_generated`（已入复习包）/ `attempted`（已作答）/ `needs_recheck`（待重练）/ `temporarily_mastered`（暂时掌握）/ `stably_mastered`（稳定掌握）/ `archived_not_worth_review`（已归档）。

**徽标 `badge`**：`ok` / `low`（识别没把握，`needs_check` 或学生手动放行；打印时印遮白裁图）。

**`recognition`**（`/v2/week` 的 photos）：`processing` / `done` / `failed`。

**推荐层级 `tier`**：`1` 上次练习没独立做对（`needs_recheck`）；`2` 上次做对了，到了再确认一次的时候（`temporarily_mastered` 到确认期）；`3` 上次是当场做对，还要隔几天再验证（`attempted`）；`4` 其余（`ready_for_reflection`/`eligible_for_review`），理由为 `本周新错题` 或 `「<知识点>」近四周错了 N 次`（N≥2）。

**做题状态 `ATTEMPT_STATES`（原文）**：`完全不会` / `知道考什么但没想到方法` / `方法基本正确但步骤出错` / `本来会但审题计算书写失误` / `时间不足` / `其他`。

**错因 `CAUSES`（原文）**：`知识概念` / `方法选择` / `推理步骤` / `计算` / `审题遗漏` / `表达规范` / `时间注意力状态`。

**把握程度 `masteryFeeling`**：`0` 仍不会 / `1` 看提示可能会 / `2` 现在重做应该会 / `3` 隔几天也有把握。

**回传 `completion` 五取值与 `correct` 约束**：

| completion | 含义 | correct | 映射到内部 |
| --- | --- | --- | --- |
| `independent` | 独立做出 | 必填布尔 | `independent`，hintLevel 0 |
| `hint1` | 看了一级提示 | 必填布尔 | `hint_used`，hintLevel 1 |
| `hint2` | 看了二级提示 | 必填布尔 | `hint_used`，hintLevel 2 |
| `not_solved` | 没做出来 | 只能缺省或 `false` | `failed` |
| `not_done` | 没做 | 只能缺省或 `false` | `unfinished` |

**修改字段 `field`**：`questionText` / `observation`（带 `observationId`）/ `subject` / `knowledgeTags`；修改方式 `method`：`voice` / `keyboard`（直改落库为 `direct`）。

**打印快照 `status`**：`none` / `preparing` / `ready` / `failed`；快照 `mode`：`text` / `crop`；答案 `source`：`paper` / `ai` / `none`。

**`paperLocation`**：`school` / `home` / `varies`。

## 5. "学生的一周"调用时序

1. `POST /v1/recognitions` 上传错题照片（v1 接口），拿 `job.id`。
2. `GET /v1/recognitions/:id` 轮询到终态（`completed` / `partial`）。
3. `POST /v2/photos/:jobId/register` 登记。
4. `GET /v2/week` 看本周错题卡片（首次调用触发懒桥接）；认错的题 `POST /v2/items/:id/discard`，反悔 `POST /v2/items/:id/restore`。
5. `PUT /v2/settings` 设置做题时段与原卷位置（`GET /v2/settings` 查看）。
6. `GET /v2/practice/recommend` 看本周推荐与理由。
7. `POST /v2/practice` 选题建练习；`GET /v2/practice/:id` 看详情（`GET /v2/practice` 看历史列表）。
8. 逐题复盘：`POST /v2/items/:id/reflection/ask` → `POST /v2/items/:id/reflection/answer`（可能产生第 2 轮，再 answer 一次）→ 学生确认后 `POST /v2/items/:id/reflection` 提交；`GET /v2/items/:id/reflection` 回看。
9. 识别不对：`GET /v2/items/:id/evidence` 拿当前内容与 `revision` → `POST /v2/items/:id/correct` 生成建议 → `POST /v2/items/:id/correct/accept` 接受；或直接 `POST /v2/items/:id/correct/direct` 键盘改。
10. `POST /v2/practice/:id/print` 请求打印快照，随后反复 `GET /v2/practice/:id/print` 轮询到 `ready`，按快照排版生成 PDF；题面图片走 `GET /v2/practice/:id/print/media/:name`。
11. 隔 3–7 天纸上做完后：`POST /v2/practice/:id/return` 回传（可分批）。
12. `GET /v2/practice/:id/summary` 看回报（掌握、再来一次、校准、下次确认日期）。
13. `GET /v2/corrections/report` 看本周修正即测量报告（计数，无题目文字）。

## 6. 客户端注意事项

- **会触发模型的调用与上限**：
  - 追问/归纳（3.17/3.18）：单题最多 3 次模型调用（提问 1 + 归纳至多 2），由结构保证；`ask` 幂等不重复调用。
  - 修改建议（3.22）：每次 1 次模型调用，每题每小时最多 6 次（含失败）；同一 `clientRequestId` 重放不调用、不计数。
  - 打印准备（3.12）：每份包每题至多 1 次 coach 调用，失败不阻塞（提示为空、答案可能只剩原卷/空）。
  - 推荐（3.8）与回报（3.16）不调用模型。
- **打印是异步的**：`POST /v2/practice/:id/print` 返回 202 后必须轮询 `GET /v2/practice/:id/print` 到 `ready`（或 `failed` 后重发 POST 续做）；快照只生成一次，之后改题不影响它。
- **`needsGlance`**：遮白裁图（`crop`）模式下，存在无法定位的手写观察记录（遮不全）或徽标为 `low`（AI 没把握，且打印裁图余量较宽可能带进相邻题目）时为 `true`；`glanceReason` 分别为 `这题的手写内容可能没有遮全，打印前请看一眼`（无法定位的手写优先）或 `这题 AI 没把握，打印前看一眼截图是否完整`。`text` 模式恒为 `false`。手机排版时应提示学生打印前看一眼原图/截图。
- **隐私**：学生原话（追问回答）与 AI 归纳只给学生本人看，**不得写入客户端日志**；修改指令与修改文字同理。家长侧只见聚合计数。
