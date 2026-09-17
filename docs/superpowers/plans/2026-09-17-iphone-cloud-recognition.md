# iPhone 云端识别（广州 ECS）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机经 `https://study.pccoding666.com` 使用广州 ECS 上的移动识别服务（真实百炼），保留逐批同意、证据完整性与单家庭资料库边界。

**Architecture:** 在现有 `src/mobile` Express 服务上新增配对/设备令牌模块与入口容量模块；Caddy 只接管 443 反代到 `127.0.0.1:3101`；iOS 端把回环配对扩展为"回环或固定云域名"两种模式并增加扫码配对、健康检查与连接状态机。

**Tech Stack:** TypeScript ESM / Express 5 / node:fs 持久化 / sharp；SwiftUI + Foundation + Security（Keychain）+ XCTest；systemd 239（cgroup v1）+ Caddy；Vitest。

**Spec:** `docs/superpowers/specs/2026-09-17-iphone-cloud-recognition-design.md`

## Global Constraints

- 仅一个家庭的一份资料库；已配对设备共享该资料，不做多账户隔离。
- AI 只提取与建议；反思由学生提交；未通过证据核对的题目不得进入确认/打印（`canRecover`/`allChecksPass` 规则不放松）。
- 云端入口只接受 `https://study.pccoding666.com`；禁止携带凭据重定向、禁止回退 HTTP；开发测试可显式回环模式。
- 百炼密钥仅服务端受限配置；二维码、手机、仓库、日志不出现任何密钥；日志脱敏（只记任务 ID、阶段、耗时、脱敏错误）。
- 速率限制：配对失败每 IP 10/分、全局 60/分；鉴权失败每 IP 30/分；已鉴权查询每设备 300/分；429 + Retry-After。
- 上传正文上限 15,000,000 字节、4000 万像素边界；单任务并发、逐题并发降为 1；待处理容量 10 张；磁盘 <3GiB 或数据 10GiB 拒收新上传。
- ECS 为 systemd 239 / cgroup v1：资源限制使用 `MemoryLimit=1G`、`CPUQuota=150%`；768MiB 仅为应用层新任务准入阈值与观测值，不得宣称内核节流；部署时必须实测 cgroup 真实生效值。不升级系统、不重启 ECS、不切换 cgroup 版本。
- Caddy 独立服务只接管 443（TLS-ALPN 签发/续期），关闭 HTTP challenge 与 HTTP→HTTPS 重定向，不占用 80；原网站 `wikiworldlife-board.service` 及其端口不动。
- 本地基线：`npm test` 275/275 通过；每任务结束须保持 `npm run typecheck` 与 `npm test` 全绿。
- 计划内任务不读取 `.env`、`data/`、用户照片、凭据；不访问生产资源；测试一律用临时目录与合成 JPEG。

## 共享接口（所有任务以此为准，禁止另行发明）

```ts
// src/mobile/pairing.ts（Task 1 产出）
export const PAIRING_PROTOCOL_VERSION = 1 as const;
export interface PairingCodePayload {
  v: 1; serviceId: string; httpsUrl: 'https://study.pccoding666.com';
  sessionId: string; secret: string; // 一次性、32字节 base64url、5分钟有效；四类 ID 均须 UUID
}
export interface RedeemResult {
  token: string; deviceId: string; serviceId: string;
  expiresAt: string; protocolVersion: 1;
}
export interface PairingManagerOptions { now?: () => Date }
export class PairingManager {
  static open(dataDir: string, options?: PairingManagerOptions): Promise<PairingManager>;
  // serviceId 首次初始化时原子持久化到 dataDir/service-id（0600），重启后读取不变。
  // 单写队列（mutation Promise 链，同 store.ts 模式）保障发令牌/撤销原子持久化：
  // 持久化失败不返回令牌、不启用新状态。devices.json（0600）仅存 SHA-256 tokenHash。
  createSession(): { payload: PairingCodePayload; expiresAt: Date };
  // redeem 语义：同 clientId + 同 secret + 有效期内重取返回完全相同的 RedeemResult（幂等恢复，
  // 仅内存；服务重启后恢复失败须重新扫码）；两个不同 clientId 并发兑换同一 sessionId 只有一个
  // 成功，另一个 409；过期/重放（换 clientId）失败。
  redeem(payload: PairingCodePayload, clientId: string, deviceInfo: string): Promise<RedeemResult>;
  authenticate(header: string | undefined): Promise<{ deviceId: string }>;  // timingSafeEqual 比对哈希
  revoke(deviceId: string): Promise<void>;
  listDevices(): Promise<Array<Omit<DeviceTokenRecord, 'tokenHash'>>>;
}
// 管理入口不经公网 app：src/mobile/adminServer.ts 在独立 Unix domain socket
//（dataDir/admin.sock，父目录 0700、socket 权限 0600）暴露 GET /pairing-code、
// POST /devices/:id/revoke 等；仅 SSH 管理员本机调用；公网 app 没有任何 /v1/admin 路由。
// src/mobile/admin-cli.ts 为管理员 CLI 客户端。同一进程持有 PairingManager 内存会话。
// GET /v1/health（已鉴权）扩展返回：
// { version: 1, serviceId, storageAvailable: boolean, visionConfigured: boolean,
//   acceptingJobs: boolean, protocolVersion: 1 }
// 错误响应统一 { error: { code, message } }；限流 429 + Retry-After。
```

```ts
// src/mobile/admission.ts（Task 3 产出）
export class AdmissionController {
  tryAcquireUploadSlot(deviceId: string): { accepted: boolean; retryAfterSeconds: number };
  tryAcquireJobCapacity(): { accepted: boolean; retryAfterSeconds: number };
  releaseUploadSlot(deviceId: string): void;   // finally 释放：aborted/failed/empty/too-large 均不泄漏
  storageGate(): { ok: boolean; reason?: 'disk_low' | 'data_quota' };
}
// 容量预约原子化（先预约后解析正文）；满队列时相同幂等键的旧任务仍可查验并按字节恢复；
// 重试不重复计照片数。共享图像信号量覆盖 normalizePhoto、上传 metadata 检查及 vision 的
// 题图/图示裁切（sharp.concurrency(1) 不保证跨请求串行）；修改 vision.ts 与 media 相关文件。
// 单进程 RSS 观测不得称为"进程组内存"。
// POST /v1/recognitions 容量满时返回 429 { error: { code: 'busy'|'capacity_full', message } }，
// 幂等键语义不变：相同键相同内容返回同一任务，不同内容 409。
```

```swift
// iOS/StudentApp/Domain/Recognition.swift（Task 4/5 修改）
// PairingConfiguration 扩展为两种模式：
// case loopback(baseURL: URL, token: String)   // 现有回环校验不变
// case cloud(serviceId: String, baseURL: URL /* 固定 https://study.pccoding666.com */,
//            token: String, deviceId: String, expiresAt: Date?)
// 连接状态 enum ConnectionState { unpaired, pairedNeedsCheck, checking, ready, busy,
//                                  failed, unauthorized, incompatible }
// redeem 响应按 RedeemResult 解码；token 恢复按相同 clientId 幂等重试；
// 每批提交前强制重新 health 检查（不是仅 30 秒缓存）；旧未知来源任务仅离线；
// 重新配对同一 service 时用代次（generation）校验丢弃迟到旧响应。
```

---

### Task 1: 配对、设备令牌与仅本机管理入口

**Files:**
- Create: `src/mobile/pairing.ts`、`src/mobile/adminServer.ts`（Unix domain socket 管理入口）、`src/mobile/admin-cli.ts`、`tests/unit/pairing.test.ts`、`tests/integration/adminServer.test.ts`（真实 socket 集成测试）
- Modify: `src/mobile/configuration.ts`（新增 cloudMode 配置）、`docs/mobile-recognition-api.md`（配对章）

**Interfaces:** 产出上文 `PairingManager.open/redeem/...` 与 `RedeemResult`；admin 入口只监听 `dataDir/admin.sock`（父目录 0700、socket 0600），公网 app 无任何管理路由；Task 2 的公网路由只挂 `POST /v1/pairing/redeem`；Task 4 扫码解码 `PairingCodePayload` 与 `RedeemResult`。

**行为清单：** 秘密 32 字节 base64url、5 分钟过期；sessionId/clientId/serviceId/QR 的 ID 均校验 UUID；单次使用；**同 clientId + 同 secret + 有效期内重取返回完全相同的 RedeemResult**（内存恢复；重启后失败须重新扫码）；两个不同 clientId 并发兑换同一 sessionId 只有一个成功；令牌 30 天有效、**单写队列保障原子持久化，落盘成功后才返回**；devices.json 只存 SHA-256 哈希；可单独撤销；令牌/秘密不进日志。

- [ ] RED：写失败测试并运行
```ts
import { PairingManager } from '../../src/mobile/pairing.js';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

it('同 clientId 有效期内重取得到相同结果；换 clientId 的重放被拒绝', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-pair-'));
  const manager = await PairingManager.open(dir);
  const { payload } = manager.createSession();
  const first = await manager.redeem(payload, 'client-a', 'iPhone');
  const again = await manager.redeem(payload, 'client-a', 'iPhone');
  expect(again).toEqual(first);
  await expect(manager.redeem(payload, 'client-b', 'Android'))
    .rejects.toMatchObject({ code: 'pairing_used' });
});
```
Run: `npx vitest run tests/unit/pairing.test.ts` → FAIL（模块不存在）
- [ ] GREEN：实现最小 `PairingManager`（内存会话 + devices.json 原子持久化），重跑至 PASS
- [ ] 补充回归：serviceId 原子初始化且重开实例不变；并发不同 clientId 只一胜；过期 410；token 哈希落盘（devices.json 无明文令牌）；撤销后 authenticate 抛 unauthorized；30 天过期；timingSafeEqual 比对；持久化失败不发令牌；admin socket 真实连接集成测试（权限 0600、返回二维码 payload JSON、拒绝写常规公网方法之外的操作）
- [ ] `npm run typecheck && npm test` 全绿；更新 API 文档配对章节；commit `feat(mobile): pairing sessions and device tokens`

### Task 2: 云端入口路由、认证与限流

**Files:**
- Create: `src/mobile/rateLimit.ts`、`tests/integration/pairingRoutes.test.ts`
- Modify: `src/mobile/router.ts`（鉴权改为设备令牌优先、旧共享令牌仅回环模式可用且云端模式禁用；挂载 redeem 路由与限流中间件）

**Interfaces:** 消费 Task 1 `PairingManager.authenticate` 与 `RedeemResult`；产出 `POST /v1/pairing/redeem`（body `{payload, clientId, deviceInfo}`，上限 16kb）、扩展 `/v1/health`（含 serviceId、acceptingJobs、protocolVersion）；**管理入口在 adminServer.ts 的 Unix socket，公网 app 无管理路由**；Task 5 iOS 健康检查按此响应解码。

**行为清单：** 客户端 IP 采用可信本机代理覆写的单值 `X-Real-IP`（Caddy `header_up X-Real-IP {remote_host}`，显式覆盖客户端传入值）；应用仅在显式 `cloudProxy` 模式且 peer 为 `127.0.0.1` 时读取并验证该头（IPv4/IPv6 合法格式），其余情况忽略一切转发头、按直连 peer 计数——不能把所有公网来源当 127.0.0.1；配对失败限流 10/IP/分 + 60 全局/分；鉴权失败 30/IP/分；已鉴权查询 300/设备/分；限流桶有过期清理与有界容量；429 返回 Retry-After；redeem 请求体上限 16kb；无令牌访问媒体 401；中间件不记录秘密。

- [ ] RED：
```ts
it('伪造 X-Real-IP 不能绕过限流，超限返回 429 与 Retry-After', async () => {
  const { request } = await setupCloud(new FixtureVision());  // cloudProxy 模式，模拟 Caddy 覆写头
  for (let i = 0; i < 31; i += 1)
    await request('/v1/recognitions', { method: 'GET', headers: { 'x-real-ip': `1.2.3.${i}` } });
  const response = await request('/v1/recognitions', { method: 'GET' });
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBeTruthy();
});
```
Run: `npx vitest run tests/integration/pairingRoutes.test.ts` → FAIL
- [ ] GREEN：实现限流桶与路由挂载至 PASS（含通过真实代理头覆写路径证明伪造头不可绕过）
- [ ] 回归清单：无令牌 health/媒体 401；redeem 过期 410/并发 409；公网 app 上不存在 /v1/admin 路由；错误体不含令牌/秘密；云端模式下旧共享令牌 401
- [ ] `npm run typecheck && npm test`；commit `feat(mobile): cloud pairing routes, device auth and rate limits`

### Task 3: 上传容量、图像通道与磁盘门槛

**Files:**
- Create: `src/mobile/admission.ts`、`tests/integration/mobileAdmission.test.ts`
- Modify: `src/mobile/router.ts`（POST /v1/recognitions 先原子预约容量再解析正文）、`src/mobile/service.ts`（`processQuestions` 并发 2→1；submit 前查询 `storageGate`；**单进程 RSS 观测**超 768MiB 阈值时 acceptingJobs=false 并记日志——不得称"进程组内存"）、`src/mobile/vision.ts` 与 `src/media/images.ts`（**共享图像信号量**：覆盖 normalizePhoto、上传 metadata 检查与 vision 内题图/图示裁切；`sharp.concurrency(1)` 不等于跨请求串行，须显式互斥）

**Interfaces:** 产出上文 `AdmissionController`；同时最多 1 个上传正文在解析（槽位满 → 429 busy 可重试，不在内存排队）；待处理容量 10（含运行中）；上传上限 15,000,000 字节与 4000 万像素不变；容量预约在 finally 中释放（aborted/failed/empty/too-large 均不泄漏槽位）。

**行为清单：** 容量满返回 429 capacity_full 而非"假成功"；**满队列时相同幂等键的旧任务仍可查询并按字节恢复**；重试不重复计照片数；幂等重传不占新容量、不同内容 409；磁盘 <3GiB 或数据目录 10GiB 拒收且提示管理；超大/损坏图片 400/413；重启后 interrupted 状态明确显示并可恢复（沿用现有 store 机制）。

- [ ] RED：
```ts
it('容量满时拒绝新任务而不是假装成功', async () => {
  const vision = new SlowVision();
  const { request } = await setupCloud(vision, { jobCapacity: 1 });
  const first = await submit(request, await jpeg());            // 占满容量
  const second = await submit(request, await jpeg('#888888'));
  expect(second.status).toBe(429);
  expect((await second.json()).error.code).toBe('capacity_full');
  expect((await request(`/v1/recognitions/${idOf(first)}`)).status).toBe(200);
});
```
Run: `npx vitest run tests/integration/mobileAdmission.test.ts` → FAIL
- [ ] GREEN：实现槽位/容量/磁盘门槛与图像信号量至 PASS
- [ ] 回归清单：上传槽位并发为 1；逐题并发 1（沿用现有 maximumActive 断言方式）；图像信号量跨请求互斥（含 vision 裁切路径）；磁盘门槛注入测试；幂等键冲突 409 保持；health.acceptingJobs 随门槛翻转
- [ ] `npm run typecheck && npm test`；commit `feat(mobile): admission control, image semaphore and storage gates`

### Task 4: iOS HTTPS 配对、健康检查与服务归属

**Files:**
- Create: `iOS/StudentApp/Domain/CloudPairing.swift`（扫码解析、`ConnectionState`、`HealthSnapshot` 解码）、`iOS/StudentApp/CameraScanner.swift`（**实际相机扫码组件**：AVFoundation 扫码 + 相机权限中文说明与拒绝后引导）、`iOS/Tests/CloudPairingTests.swift`
- Modify: `iOS/StudentApp/Domain/Recognition.swift`（`PairingConfiguration` 双模式）、`RecognitionClient.swift`（健康检查 `GET /v1/health`、redeem 调用、token 恢复按相同 clientId 幂等重试、超时区分：检查 15s / 上传 180s）、`PairingStore.swift`（云模式存 serviceId/deviceId/到期）、`StudyStore.swift`（任务与媒体缓存加 `serviceId` 归属；**重新配对同一 service 时用代次 generation 校验丢弃迟到旧响应**）、`RecognitionView.swift`、`iOS/Package.swift` 与 `iOS/SuperErrorLog.xcodeproj/project.pbxproj`（新源文件接入构建）

**Interfaces:** 消费 Task 2 health 响应与 `RedeemResult`；产出 `ConnectionState` 与 `StudyStore.checkConnection()`（合并并发检查；30 秒缓存仅用于状态显示，**每批提交前强制重新检查**；配对成功/回前台/打开确认页触发；后台、网络失败、授权失效立即清除 ready 状态）。

**行为清单：** 只接受固定云域名 HTTPS 与显式回环模式；拒绝任意服务器二维码、拒绝携带凭据重定向（现有 delegate 已禁止重定向，扩展断言）；任务/媒体缓存按 serviceId 隔离，旧 Mac 来源未知任务保留**仅离线可看**、不自动向新服务查询或混并；切换配对取消旧请求并校验迟到响应的服务代次；本地照片、反思、练习包不因换连接丢失。

- [ ] RED：
```swift
func testQRRefusesArbitraryServerAndRequiresHTTPS() throws {
  XCTAssertThrowsError(try CloudPairing.parse(#"{"v":1,"serviceId":"s","httpsUrl":"https://evil.example","sessionId":"x","secret":"y"}"#))
  XCTAssertNoThrow(try CloudPairing.parse(#"{"v":1,"serviceId":"s","httpsUrl":"https://study.pccoding666.com","sessionId":"x","secret":"256bitsecret256bitsecret256bitsec"}"#))
}
func testHealthSnapshotRejectsMissingServiceId() throws {
  XCTAssertThrowsError(try RecognitionCodec.decoder().decode(HealthSnapshot.self,
    from: Data(#"{"version":1,"storageAvailable":true,"visionConfigured":true,"acceptingJobs":true}"#.utf8)))
}
```
Run: `cd iOS && env DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test` → FAIL
- [ ] GREEN：实现双模式配置、扫码解析、健康解码与状态机至 PASS
- [ ] 回归清单：合成 URLProtocol 测 redeem 请求形状与 Authorization 头；回环模式回归（现有 loopback 测试全保）；迟到响应 serviceId/代次不匹配被丢弃；令牌脱敏（错误消息替换 token 已有，扩展到 deviceId）
- [ ] `swift test` + `npm test` 全绿；commit `feat(ios): cloud pairing, health check and service ownership`

### Task 5: 中文扫码与上传 UI

**Files:**
- Modify: `iOS/StudentApp/ThisWeekView.swift`（"连接识别服务"设置页：扫码主入口 + "检查连接/重新配对"；状态徽标）、`StudyStore.swift`（`checkConnection` 接 UI；**每批提交强制 health 重查**；逐张状态）、`RecognitionView.swift`（上传确认页逐张提交/排队/识别/待核对/失败）、`iOS/UITests/StudentJourneyTests.swift`
- Create: `iOS/UITests/CloudConnectionJourneyTests.swift`（合成服务器：SyntheticRecognitionServer 扩展 health/redeem）

**行为清单：** 状态独立于配置：未配对、已配对待检查、检查中、可以上传、服务繁忙、连接失败、授权失效、版本不兼容，各有中文文案与操作（重试/重新配对/查看帮助）；上传确认页文案改为"上传到你的广州云服务器，再由阿里云百炼处理"，同意绑定照片集合与 serviceId；逐张显示 提交/排队/识别/待核对/失败；检查不上传照片、不调收费模型；重试复用已保存副本与幂等键，不自动重调模型到成功；切换配对取消旧请求。

- [ ] RED：
```swift
func testConnectionStatesShowChineseActions() {
  // 合成服务器返回 429 后，UI 必须显示"服务繁忙"并提供"稍后再试"，而不是灰色不可用按钮
  app.launchArguments += ["-test-session", sessionUUID]
  app.launch()
  XCTAssertTrue(app.staticText["connection-state-busy"].waitForExistence(timeout: 10))
  XCTAssertTrue(app.buttons["retry-connection"].isEnabled)
}
```
Run: `env DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -project SuperErrorLog.xcodeproj -target StudentAppUITests -configuration Debug -sdk iphonesimulator SYMROOT=build/Manual CODE_SIGNING_ALLOWED=NO -quiet` 构建，再 `xcodebuild test-without-building -xctestrun StudentJourney.xctestrun -destination 'platform=iOS Simulator,id=<设备UUID>' -resultBundlePath build/ui-cloud-<UNIQUE>.xcresult` → FAIL
- [ ] GREEN：实现 UI 与状态机接线至 PASS
- [ ] 回归清单：未配对时上传按钮禁用但入口可见；配对成功触发检查；**每批提交前强制重新检查**（即使 <30s）；回环模式 UI 不回归；重建后按 `iOS/README.md` 的签名 helper 再跑 UI 测试
- [ ] commit `feat(ios): Chinese cloud pairing and upload journey UI`

### Task 6: 安全发布包、Caddy 443 与 systemd（cgroup v1）

**Files:**
- Create: `scripts/build-release.sh`（白名单打包：仅 `dist/`、`package.json`、`package-lock.json`、配置模板；排除工作目录/照片/.env/Git 历史）、`deploy/caddy/Caddyfile`、`deploy/systemd/super-error-log.service`、`deploy/README.md`
- Modify: `package.json`（`release:build` 脚本）

**Caddyfile 要点：** 全局选项 `auto_https disable_redirects`、`admin off`（或私有本地 admin 入口）；站点块 `study.pccoding666.com { tls { issuer acme { disable_http_challenge } } request_body { max_size 15000000 } reverse_proxy 127.0.0.1:3101 { header_up X-Real-IP {remote_host} transport { read_timeout 180s } } }`——`request_body` 在站点层而非 reverse_proxy 内，max_size 精确为 15000000；`header_up X-Real-IP {remote_host}` 覆盖客户端传入值；不启用 on-demand TLS。单独的 Caddy systemd 服务，不动原网站。

**systemd 单元要点（239/cgroup v1）：** 专用低权限用户；`ExecStart=<锁定安装路径的 node 绝对路径> /opt/super-error-log/current/dist/mobile/server.js`（Node 24 LTS 安装在受控发布目录，不是 `/usr/bin/node`）；`EnvironmentFile=/etc/super-error-log/env`（0600）；`MemoryLimit=1G`、`CPUQuota=150%`、`Restart=on-failure`；工作目录 `/var/lib/super-error-log/`（专用用户私有）；768MiB 是应用层准入阈值（Task 3 已实现），文档明确"不宣称内核在 768MiB 节流"。

**验收（部署时由主控执行，不在本任务自动连服务器）：**
- [ ] 发布包清单核对：`tar -tzf` 无 .env/照片/构建缓存/源仓库之外内容；`scripts/build-release.sh` 自身有脚本行为测试（在临时目录产包并断言内容清单）；Linux 生产依赖在受控发布目录 `npm ci --omit=dev` 完成，不复制 macOS 原生模块
- [ ] 服务器上实测（部署阶段）：**直接读 `/sys/fs/cgroup/.../memory.limit_in_bytes` 与 `cpu.cfs_quota_us`**（`systemctl show` 不是内核读回）；核对低权限目录权限与监听端口（仅 127.0.0.1:3101 + admin socket）；`systemctl status wikiworldlife-board` 未被改动；`ss -ltnp` 确认 443 由 Caddy、80 仍属原服务；`caddy validate --config` 通过；无令牌 `curl https://study.pccoding666.com/v1/health` 返回 401
- [ ] 回滚与备份：发布前对已有云端状态做本机受限备份（不经 HTTP）；回滚步骤写入 deploy/README.md（保留上一版本目录、切换软链、仅重启错题本服务，不删照片、不动原网站）；数据格式变化向后兼容或有验证过的恢复步骤
- [ ] 本地校验：`npm run verify` 全绿；commit `build(deploy): release package, Caddy 443 config and cgroup v1 service`

### Task 7: 全量验证与真机验收清单

**Files:**
- Create: `docs/quality/2026-09-17-cloud-recognition-acceptance.md`
- Modify: `iOS/VERIFICATION.md`、本计划勾选框

**步骤：**
- [ ] 本地：`npm run verify`（typecheck+test+build+e2e）与 `swift test`、模拟器 UI 测试、真机目标构建 `xcodebuild -project SuperErrorLog.xcodeproj -scheme SuperErrorLog -sdk iphoneos build CODE_SIGNING_ALLOWED=NO`；无法执行的测试如实记录
- [ ] 十张合成高分辨率照片压测（临时目录，含并发上传、幂等冲突、队列满、磁盘注入、中断恢复），只评估资源，不当识别质量结论
- [ ] 部署后服务器检查清单：标准 TLS 证书链、无令牌访问拒绝、授权 health 正常、媒体保护、内存/磁盘水位、cgroup 实测值
- [ ] 真机验收：同一 iPhone 更新应用保留数据 → 扫码 → 蜂窝网络明确同意上传 1 张真实照片 → 核对 手机提交/ECS 任务/百炼返回/手机结果 四方对应；之后用户选定 10 张逐张报告结果与人工确认；无任务在跑时验证断线恢复、单设备撤销、服务重启
- [ ] 最终报告分别覆盖：域名/HTTPS、授权、上传、真实返回、内容质量、故障恢复；完成后由主控推送既有 GitHub 分支（不强推、不含私有制品/密钥/照片）

## Preflight review

Task 2 依赖 Task 1 的 `PairingManager`；Task 3 的 `AdmissionController` 在 Task 2 已预留路由挂点；Task 4/5 依赖 Task 2 冻结的 health/redeem 响应形状；Task 6 不改业务代码，只打包既有产物；Task 7 只消费前六项。共享接口块是唯一事实来源，任何任务不得私改字段名。
