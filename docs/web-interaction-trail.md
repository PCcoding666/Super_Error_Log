# 学生网页版的互动记录（interaction trail）

日期：2026-10-11（quality round 1）。代码：`src/web/trail.ts`（服务器）、`src/web/clientScript.ts` 里的 `trailAdd` / `trailSend`（页面脚本）。
测试：`tests/unit/webTrail.test.ts`（路由模板、cookie 解析）、`tests/integration/webClient.test.ts`「互动记录」（五类事件都写进审计日志、不带内容）、
`tests/e2e/webClient.spec.ts` 周末 A 末尾（真实浏览器里的点按、看页、提交、跳过）。

## 为什么

第一个真实周末要能回答：他打开了哪几页、在哪一步停下、点了哪个按钮、跳过了什么、在哪里出错、每一步花了多久。
这些只靠服务器上已有的业务事件（`v2_practice_created` 之类）看不出来。

## 记在哪里、记什么

沿用现有的审计日志 `audit()`（`src/services/eventLog.ts`）：每个事件一行，同时进 `audit_event` 表和 `events.log`。
不加表、不加字段、不改接口。

| 列 | 内容 | 例子 |
|---|---|---|
| `created_at` | 服务器时间戳（ISO 8601） | `2026-10-17T02:13:45.120Z` |
| `name` | 事件类型：`web_view` / `web_tap` / `web_submit` / `web_skip` / `web_error` | `web_tap` |
| `entity_type` | `路由模板#动作` | `/s/why/:pid/:itemId/confirm#primary.submit` |
| `entity_id` | 设备 ID（配对兑换得到的那台设备）；还没配对时为空 | `1d615463-…` |

**只有这四样。** 路由只记模板：练习、题目、照片的 ID 一律换成 `:pid`、`:itemId`（或 `:id`）、`:jobId`；
查询参数（包括配对链接里的一次性码）、题目、回答、照片、名字、按钮上的文字都不进日志。
不像路由的路径（例如手打的地址）一律记成 `/s/*`。

读法：`SELECT created_at, name, entity_type FROM audit_event WHERE entity_id = ? AND name IN ('web_view','web_tap','web_submit','web_skip','web_error') ORDER BY created_at;`
或者 `readTrail(deviceId)`（`src/web/trail.ts`，返回 `{ at, kind, route, action, deviceId }`）。

## 事件列表

| 类型 | 什么时候记 | 由谁判定 | 动作（`#` 后面） | 例子 |
|---|---|---|---|---|
| `web_view` | 打开了一页（200） | 服务器 | `open`；没配对时打开的是连接页，记 `connect`；等 AI 的页面局部更新、换上了新状态时记 `update`（页面脚本报，一次状态变化一条，见下）；R1 的整页自动刷新记 `refresh`（旧页面还可能发） | `/s/photos#open`、`/s/photos#update`、`/s/#connect` |
| `web_tap` | 点了一个按钮或链接 | 页面脚本 → 服务器 | `角色.按钮标识`。角色：`primary`（底部主按钮）、`secondary`（底部次要按钮）、`content`（页面里的链接、清单行）、`top`（顶部返回、设置）。按钮标识是固定的英文键（`data-key` / `data-testid`），不是按钮上的字 | `/s/#primary.capture`、`/s/capture#secondary.skipShoot`、`/s/#content.today-step-pick`、`/s/items/:itemId#top.back` |
| `web_submit` | 提交了一个表单（服务器收下了） | 服务器 | `submit`；录结果分 `submit:date` / `submit:next` / `submit:prev` / `submit:final` | `/s/choose#submit`、`/s/record/:pid#submit:prev` |
| `web_skip` | 跳过 | 服务器 | 跳过的是哪一步：`shoot` / `why` / `record`；说说为什么错里「这道跳过」记 `item` | `/s/skip#why`、`/s/why/:pid/:itemId/pass#item` |
| `web_error` | 服务器回了 4xx / 5xx，或者处理失败但跳回了页面（重试没成功、有题没提交上） | 服务器 | `状态码` 或 `状态码:原因`（原因是固定的短标识） | `/s/record/:pid#400:date_missing`、`/s/capture#400:unreadable`、`/s/*#404`、`/s/#401:unauthorized` |
| `web_error` | 浏览器里出的错（服务器看不到） | 页面脚本 → 服务器 | `client:原因` | `/s/why/:pid/:itemId#client:mic_denied` |

服务器端的出错原因：`unreadable` `too_big` `busy` `full` `paused` `empty` `consent_required`（上传）；`date_missing` `completion_missing` `correct_missing` `item_missing` `return_failed` `return_rejected`（录结果）；
`missing` `submit_failed` `answer_invalid`（说说为什么错）；`none_chosen` `too_many` `conflict` `create_failed`（选题）；`none_picked` `select_failed` `retry_failed`（勾题）；
`fix_failed` `fix_accept_failed` `edit_failed` `discard_refused`（改题）；`settings_invalid`；`unauthorized` `cross_site`；配对失败记配对模块的错误码（`pairing_used` 等）。

页面脚本报的原因：`mic_denied`（不给麦克风）、`voice_empty`（没听清）、`voice_<状态码>`（转写失败）、`voice_network`、`upload_network`（上传时断网）。

## 点按怎么到服务器

页面是服务器渲染、表单驱动的，点一个按钮多半就是跳一页。脚本在点的那一刻把一条
`短随机 ID.角色.按钮标识@页面路径` 放进短命 cookie `sel_tap`（`Path=/s`、`SameSite=Lax`、120 秒、最多 6 条；
脚本要写它，所以**不是** httpOnly），它随下一个请求到服务器，服务器记下后立即清掉。
不跳页的点按（拍照、从相册选、打印、录音）脚本会立刻对当前页发一个 `HEAD`，服务器记完回 204。
同一条点按可能随两个并发请求一起到，服务器按「设备 + 短 ID」去重。

## 等 AI 的页面：局部轮询（quality round 2）

找题中（`/s/photos`、`/s/capture`、`/s/`）和练习纸准备中（`/s/print/:pid`、`/s/`）的页面不再整页刷新。页面脚本每隔几秒带
`x-sel-poll: 1` 取同一页，只比较标了 `data-live` 的区域：

- 轮询请求本身**不记** `web_view`（服务器看到这个头就跳过「打开了一页」）。所以等了 2 分钟不会留下 40 条看页记录。
- 区域真的变了、脚本把它换上去以后，记一次 `web_view <路由>#update`（随一个 HEAD 带来，和不跳页的点按一样）。
  一次状态变化一条；状态没变的轮询什么都不记。
- 轮询超时、429 或 5xx 保留当前页面并退避重试，避免丢失正在准备或待重试的照片；登录失效才重新进入登录页。服务端仍记录相应错误。
- 关掉脚本时退回 `<meta refresh>`：每次刷新都是一次真正的打开，记 `web_view …#open`（和 R1 一样）。

新的按钮标识（点按照常由页面脚本记成 `web_tap`，只有固定的英文键）：`content.voice-retry`（录音转写失败后「再转一次」，用的是同一段录音）、
`content.sheet-open`（打印页、练习纸单独页上展开 / 收起整张 A4）。

## 不记的东西

- 图片、样式、脚本、manifest、Service Worker、离线页（只有 worker 预缓存时才从服务器取）。
- `/s/voice` 的请求本身不在服务器上记（转写请求不往数据目录写任何东西）；录音按钮的点按和转写失败由页面脚本记成 `web_tap` / `web_error`。
- 关掉脚本时没有 `web_tap`（其余四类照记，都在服务器上判定）。
- 输入的内容、选了哪个选项（录结果的做法、有没有把握）——这些是业务数据，已经各自存在业务表里，不重复进日志。

## 用来回答的问题（第一个真实周末之后）

- 周末 A 从配对到「打印好了」用了多久，每一步多久：相邻 `web_view` / `web_submit` 的时间差。
- 在哪里停下、有没有回头：最后一条事件、`top.back` 的次数。
- 「跳过」用在哪：`web_skip`。
- 有没有卡住：`web_error`；等 AI 等了多久：同一页 `#open`（或上一条 `#update`）到下一条 `#update` 的时间差（R1 的旧页面是反复的 `#refresh`）。
