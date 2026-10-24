# 原生 App 的邀请码登录（/s/native，2026-10-23）

> 命名：`/s/api` 已是网页单页应用（`client/`，`src/web/api.ts`）的 cookie 接口，由 worker 处理；原生 App 用 **`/s/native`**，由网关处理，两者互不相干。

读者：iOS 客户端与网关维护者。字段名、状态码、文案以 `src/studentHost/router.ts` 为准；iOS 侧对应
`iOS/StudentApp/Domain/Recognition.swift`（`PairingConfiguration.invitation`）、`RecognitionClient.swift`
（`loginInvitation` / `logoutInvitation`）与 `StudyStore.swift`（`loginWithInvitation` / `logout`）。

## 为什么有这一层

手机网页版 `/s/` 用邀请码登录、按学生隔离 worker 进程；原生 App 原来只会旧的单学生扫码配对（`/v1/pairing/redeem`），
和现在的账号体系脱节。网关在 `/s/native` 下加了一组 **只给原生 App** 的 JSON 接口：同一张邀请码、同一张会话表，
鉴权后把请求改写到该学生自己的 worker 的 `/v1` `/v2`。学生在网页版和 App 里看到的是同一份记录。

## 接口

所有响应 `cache-control: private, no-store`；错误信封与 `/v2` 相同：`{ "error": { "code", "message" } }`。

### `POST /s/native/login` — 兑换邀请码（免鉴权）

请求 JSON（≤ 4 KB）：`{ "code": "ABCD-EFGH-JK12", "deviceInfo": "iPhone" }`。码的规范化（去空格/短横线、大写）由服务器做。
不要带 cookie；带了 `Origin` 就按网页同源规则校验（跨站 403）。

- `200 { "token", "serviceId", "expiresAt", "protocolVersion": 1 }`
  - `token`：会话令牌（与网页 `sel_student` 同一张表：30 天，活跃使用每天最多顺延一次）。只在这一刻返回明文。
  - `serviceId`：该学生 worker 的服务标识（每个学生目录一份，重启不变）。App 之后每次 `/v1/health` 都核对它。
- `400 invalid_code`：码不对或已失效（不区分「不存在」与「格式错」）。
- `429 rate_limited` + `Retry-After`：与网页登录共用同一套按码计数（同一个码 10 次失败后挡 10 分钟；成功不计）。
- `503 capacity | unavailable` + `Retry-After`：学生空间没起来。**不发令牌**，刚建的会话立即撤销，App 稍后重试会重新兑换。
- `403 forbidden`：跨站来源。

### `POST /s/native/logout` — 退出

`Authorization: Bearer <token>`。撤销这枚令牌，`204`；令牌缺失/已失效同样 `204`。

### `/s/native/v1/*`、`/s/native/v2/*` — 转发到该学生 worker

`Authorization: Bearer <token>`，鉴权失败 `401 unauthorized`。网关把路径去掉 `/s/native` 前缀转给 worker
（`/s/native/v2/week` → worker `/v2/week`），用只有父进程知道的内部设备令牌作 Bearer，不带任何 cookie。
放行范围：`/v1/health`、`/v1/recognitions…`、`/v2/…`；**`/v1/pairing` 与网页路径永远 404**。
保留转发的请求头：`accept`、`content-type`、`content-length`、`idempotency-key`、`x-photo-name`、`x-sel-poll`、`user-agent`、`accept-language`。
接口语义见 `docs/mobile-recognition-api.md`（/v1）与 `docs/mobile-v2-api.md`（/v2）。

## 边界

- cookie 会话进不了 `/s/native`（401）；令牌进不了网页路由（只看到登录页）。两套凭据在同一张 sessions 表，但入口互斥。
- 编码字符、`..`、`\` 的路径一律 404，先于转发检查（`safeRelativeUrl` → `nativeUpstreamUrl`）。
- 每个学生一个 worker、一个内部设备令牌：worker 侧的「每设备 300 次/分钟」限流对该学生的 App 与网页合计生效。
- 测试：`tests/integration/studentHostNative.test.ts`（真实网关 + 真实 fork worker + 合成识别）。

## iOS 侧

- `PairingConfiguration.invitation(baseURL:serviceId:token:expiresAt:)`：入口必须恰为白名单主机的 `https://<host>/s/native`
  （`CloudPairing.nativeAPIURL(forHost:)`）；`isCloud == true`，健康检查、归属校验、连接状态机与扫码配对完全一样；
  `isInvitation == true` 时设置页多一个「退出登录」。钥匙串存储形状 `{ mode: "invitation", baseURL, serviceId, token, expiresAt? }`，
  读回时重新走白名单校验。
- 登录页 `InvitationLoginView`：12 位邀请码 + 入口（域名 / IP 直连）；旧扫码配对保留为次要入口。
- `-cloud-loopback` UI 测试覆盖对 invitation 模式同样生效（覆盖地址后缀 `/s/native`）；现有 UI 测试仍走扫码路径。
- 单元测试：`iOS/Tests/InvitationLoginTests.swift`。
