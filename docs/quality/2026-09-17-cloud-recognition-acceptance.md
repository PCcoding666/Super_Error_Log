# 云端识别交付验收（2026-09-17 计划）

日期：2026-09-18。计划：`docs/superpowers/plans/2026-09-17-iphone-cloud-recognition.md`（Task 1–6 代码交付，Task 7 本文档）。

## 一句话结论

**云端识别的全部代码与本地验证已交付（后端 357/357、iOS 51+19 全绿、十张合成照片压测通过）；域名部署、真实百炼调用与真机扫码验收尚未执行，本文件给出部署时必须逐项实测的清单。任何合成测试的通过都不构成识别质量或真实照片验收结论。**

## 本地验证结果（全部实际执行）

| 验证项 | 结果 | 证据 |
| --- | --- | --- |
| `npm run verify`（typecheck + 测试 + 构建 + e2e） | 全绿，exit 0：typecheck PASS；Vitest **357/357**（33 文件，含本计划新增 stressTenPhotos 3 项）；构建成功；Playwright **9/9** | 2026-09-18 完整运行（注：Playwright globalSetup 清理自用 `data-e2e/` 目录需在沙箱外运行） |
| `swift test`（iOS 域/客户端） | **51/51** 通过 | 本机 Xcode 26.6，`env DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` |
| 模拟器 UI 全套 | **19/19** 通过，0 失败 0 跳过，约 515 秒 | `iOS/build/ui-task7-cloud-200607.xcresult`（iPhone 17 Pro / iOS 26.3.1） |
| 真机目标构建 | BUILD SUCCEEDED | `xcodebuild -project SuperErrorLog.xcodeproj -target SuperErrorLog -configuration Debug -sdk iphoneos CODE_SIGNING_ALLOWED=NO SYMROOT=build/Device`。如实记录：计划原文的 `-scheme SuperErrorLog` 形式在本机报 "Found no destinations"，`-target` 形式是等价的构建门；签名与真机安装属部署阶段 |
| 十张合成照片压测 | **3/3** 通过（详见下节） | `tests/integration/stressTenPhotos.test.ts`，独立子进程真实 `dist/` 服务、临时目录、合成 JPEG |

无法本地执行而如实留空的：真实域名 TLS、真实 cgroup 生效值、真实百炼返回、真机相机/打印机——全部进入下文部署与真机清单，不得以本地结果冒充。

## 十张合成高分辨率照片压测（资源行为，非识别质量）

测试形态：独立 Node 子进程运行真实 `dist/mobile/router.js`（云端模式 + 容量 5 + 可注入磁盘探测 + 1 题 FixtureVision 门控），4000×3000 合成 JPEG 经真实 HTTP 提交。**识别引擎是合成夹具，模型一次都没被调用；本节只评估资源与入口语义。**

1. **并发上传 + 队列满**：10 张并发提交（真实客户端式 429 `busy` 退避重试，250–500 ms 抖动）→ 恰好 5 张 202 受理、5 张 429 `capacity_full`；`busy`（解析槽位）与 `capacity_full`（任务容量）两个 429 语义分开断言。
2. **幂等重放**：同幂等键重放已受理任务 → 202 同 jobId，不占新容量。
3. **容量归还**：全部任务终态后再提交新照片 → 202 受理。
4. **磁盘门槛**：注入系统盘 2 GiB（<3 GiB 阈值）→ 503 `disk_low`，任务数为 0（不产生半受理任务）。
5. **中断恢复**：SIGKILL 杀掉处理中的服务 → 重启后任务 `interrupted`（在途题目 `failed` + `error.code=interrupted`），等待 2 秒确认**无自动恢复**；整单 retry（`questionId:null`）正确返回 409 `not_retryable`（清单阶段专用）；对被中断题目做**题目级显式 retry** → 202 → 走到终态。这同时回归了"恢复必须显式、按题"的产品规则。

压测结论：容量、槽位、磁盘、幂等、中断语义全部按计划行为执行；资源水位（RSS 准入阈值 768 MiB 属应用层观测）无越界。**不据此对识别质量、覆盖率或真实照片行为作任何声明。**

## 部署后服务器检查清单（部署阶段逐项实测，勾选前不算通过）

- [ ] `caddy validate --config /opt/super-error-log/current/deploy/caddy/Caddyfile` 通过
- [ ] **TLS 证书链**：`openssl s_client -connect study.pccoding666.com:443 -servername study.pccoding666.com` 显示有效证书链（Let's Encrypt，TLS-ALPN-01 签发）
- [ ] **无令牌访问拒绝**：`curl -s -o /dev/null -w '%{http_code}' https://study.pccoding666.com/v1/health` = **401**（无令牌 health 也必须 401，云端模式下不匿名泄漏任何状态）
- [ ] **授权 health 正常**：管理员经 `admin-cli` 发码、手机兑换后，带设备令牌 `GET /v1/health` 返回 200 且 `{version, serviceId, storageAvailable, visionConfigured, acceptingJobs, protocolVersion}` 字段齐全
- [ ] **媒体保护**：无令牌 GET 任意 `/v1/recognitions/:id/media/:mediaId` = 401；带令牌仅能读自己 serviceId 的任务媒体
- [ ] **80/443 归属**：`ss -ltnp` 确认 443 由 Caddy 持有、80 仍属原 `wikiworldlife-board.service`；`systemctl status wikiworldlife-board` 未被改动
- [ ] **cgroup 实测值（内核读回，不用 systemctl show）**：`cat /sys/fs/cgroup/memory/.../memory.limit_in_bytes` = **1073741824**；`cat /sys/fs/cgroup/cpu/.../cpu.cfs_quota_us` = **150000**、`cpu.cfs_period_us` = **100000**
- [ ] **内存/磁盘水位**：部署后连续观察 `journalctl -u super-error-log` 无 `[admission] RSS 超阈值` 告警刷屏；`df` 确认数据盘余量 > 3 GiB；`storageGate` 未触发 `data_quota`
- [ ] **监听面**：应用仅监听 `127.0.0.1:3101` + 本机 admin Unix socket（0600）；公网只有 Caddy 的 443
- [ ] **回滚演练**：按 `deploy/README.md` §6 在测试窗口演练一次软链切换 + 仅重启错题本服务，原网站与 ACME 备份快照确认无损

## 真机验收清单（需要实体 iPhone + 已部署服务器，用户参与）

1. **数据保留更新**：同一 iPhone 从现有安装更新为云版本（不删应用），本地照片、反思、练习包全部保留。
2. **扫码配对**：设置页"连接识别服务"→ 实际相机扫码（含相机权限拒绝后的引导路径）→ 状态徽标走 未配对→检查中→可以上传。
3. **蜂窝网络明确同意**：关 Wi-Fi 用蜂窝上传 **1 张真实照片**，确认页逐张显示 提交→排队→识别→待核对，文案"上传到你的广州云服务器，再由阿里云百炼处理"。
4. **四方对应核对**：手机提交记录（照片+幂等键+时间）↔ ECS 任务（`data/real/` 下 jobId 与 sourceHash）↔ 百炼返回（journalctl 脱敏日志的阶段与耗时）↔ 手机结果页候选数与状态，四方一致。
5. **十张逐张**：用户选定 10 张真实照片逐张提交、逐张报告结果并人工确认；每张保留"待核对/失败"原样，不静默重试、不代填反思。
6. **无任务在跑时**：断线恢复（飞行模式开→关→状态自愈）、单设备撤销（admin-cli revoke → 手机下次请求 401 unauthorized → 重新扫码）、服务重启（systemctl restart → 手机端 interrupted → 显式 retry）。

## 最终报告章节对照（六项，标注当前证据等级）

| 章节 | 已有本地证据 | 部署/真机补充项 |
| --- | --- | --- |
| **域名/HTTPS** | Caddyfile 固定站点 `study.pccoding666.com`、`disable_http_challenge`、不占 80、admin off；iOS 端拒绝任意域名二维码与携带凭据重定向（单测） | TLS 链实测、443/80 归属、`caddy validate` |
| **授权** | PairingManager 全语义（一次性会话、同 clientId 幂等、并发单胜、30 天令牌、SHA-256 落盘、撤销）；限流四档（配对失败 10/IP/分 + 60 全局、鉴权失败 30/IP/分、已鉴权 300/设备/分）+ 429 Retry-After；伪造 X-Real-IP 不可绕过（集成测试） | 真机扫码全流程、撤销后 401 实测 |
| **上传** | 15 MiB 上限、4000 万像素边界、400/413 分类；原子容量预约（先预约后解析正文）；`busy` vs `capacity_full` 两种 429；幂等重放 202/冲突 409；磁盘 <3 GiB 拒收；槽位/容量 finally 释放不泄漏（十照片压测 + 集成测试） | 蜂窝网络真实 15 MiB 内照片上传 |
| **真实返回** | 中断/重启/显式恢复全链路（集成 + 压测）；attempt 记录与脱敏日志形状 | **尚无一次真实百炼调用**——部署后第 1 张真实照片的四方对应 |
| **内容质量** | 证据完整性门槛（canRecover/allChecksPass/occurrence 冲突）全部回归测试保绿；**合成压测明确不评估内容质量** | 十张真实照片逐张人工核对（沿用 2026-09-15 验收的严格标准：不漏题、忠实保留原始作答、不误放行） |
| **故障恢复** | interrupted 标记 + 无自动恢复 + 题目级显式 retry（含 409 not_retryable 语义）；磁盘门槛 503；RSS 准入阈值可恢复 | 服务重启实测、断线状态自愈实测 |

## 边界与诚实声明

- 本文件所有"通过"均指**本地可执行验证**；域名、TLS、cgroup、真实模型、真机相机各项在部署与真机清单勾选前一律视为**未验证**。
- 压测通过 ≠ 识别质量结论；FixtureVision 一次真实模型都没调。
- 云端模式仍遵守领域铁律：AI 只提取建议、反思必须学生提交、证据核对不过不放行确认/打印。合成测试不触碰真实错题库。
- 部署动作由主控在部署阶段执行（不在本任务自动连服务器）；`deploy/README.md` 是部署的唯一操作手册。
