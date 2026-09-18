# 云端识别交付验收（2026-09-17 计划）

日期：2026-09-18。计划：`docs/superpowers/plans/2026-09-17-iphone-cloud-recognition.md`（Task 1–6 代码交付，Task 7 本文档）。

## 一句话结论

**云端识别服务已在广州 ECS 上线并通过服务器侧全部验收（TLS-ALPN-01 签发、配对/鉴权/限流/容量/请求体上限全链路实测）；本地基线 357/357 + iOS 51+19 全绿。真实百炼调用与真机扫码验收尚未执行——手机侧清单逐项实测前不算通过。任何合成测试的通过都不构成识别质量或真实照片验收结论。**

## 本地验证结果（全部实际执行）

| 验证项 | 结果 | 证据 |
| --- | --- | --- |
| `npm run verify`（typecheck + 构建 + 测试 + e2e） | 全绿，exit 0：typecheck PASS；构建成功；Vitest **357/357**（33 文件，含本计划新增 stressTenPhotos 3 项，压测消费当前构建的 `dist/`，故 verify 顺序为 build→test）；Playwright **9/9** | 2026-09-18 完整运行（注：Playwright globalSetup 清理自用 `data-e2e/` 目录需在沙箱外运行） |
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

## 部署后服务器检查清单（2026-09-18 实际部署实测，全部通过）

部署记录：ECS `8.163.96.197`（Alibaba Cloud Linux 3 / Anolis 8，systemd 239，cgroup v1）；Node v24.21.0（官方 linux-x64 二进制，受控目录 `/opt/super-error-log/node-v24`）；Caddy v2.10.0（官方二进制，`/usr/local/bin/caddy`）；发布包 `super-error-log-0.1.0.tar.gz`（sha256 `bc98143b…`，白名单清单 92 条目）；版本目录 `/opt/super-error-log/releases/0.1.0` + `current` 软链；服务 `super-error-log.service` 与 `super-error-log-caddy.service` 均 enable --now。

- [x] `caddy validate --config /opt/super-error-log/current/deploy/caddy/Caddyfile` 通过（Valid configuration）
- [x] **TLS 证书链**：Let's Encrypt（issuer CN=YE2）经 **TLS-ALPN-01** 签发成功（journalctl 记录 challenge 全过程）；`openssl s_client` Verify return code 0 (ok)，subject CN=study.pccoding666.com
- [x] **无令牌访问拒绝**：`curl https://study.pccoding666.com/v1/health` = **401**（云端模式不匿名泄漏状态）
- [x] **授权 health 正常**：admin-cli 发码 → 公网 redeem 200（设备令牌 43 字符）→ 带令牌 `GET /v1/health` 返回 200 且六字段齐全（`storageAvailable:true, visionConfigured:true, acceptingJobs:true, protocolVersion:1`——真实百炼密钥已配置）
- [x] **媒体保护**：无令牌 GET media = 401
- [x] **80/443 归属**：`ss -ltnp`：443 = caddy（pid 确认）、80 = 原网站 python3（wikiworldlife-board，active 未动）、3101 = 127.0.0.1 独占
- [x] **cgroup 实测值（内核读回）**：`memory.limit_in_bytes` = **1073741824**；`cpu.cfs_quota_us` = **150000**、`cpu.cfs_period_us` = **100000**（systemctl show 对照一致：MemoryLimit=1073741824、CPUQuotaPerSecUSec=1.5s）
- [x] **内存/磁盘水位**：部署后 journalctl 无 RSS 告警；`df /` 32G 可用（>3GiB 磁盘门槛）；机器 2G 内存（MemoryLimit=1G 内 + 768MiB 应用层准入适配合理）
- [x] **监听面**：应用仅 `127.0.0.1:3101` + `/var/lib/super-error-log/admin.sock`（0600 supererrorlog）；公网仅 Caddy 443
- [x] **入口限流实测**：无令牌连打 31 次 → 恰 30×401 + 第 31 次 429；**伪造 X-Real-IP: 1.2.3.4 不能绕过**（Caddy `header_up` 覆写 + 应用仅信本机 peer）
- [x] **请求体上限实测**：14 MiB 正文过 Caddy 到应用（400 invalid_image，零字节非 JPEG）；16 MiB 被 Caddy 413 拦截（`request_body max_size 15000000` 生效）
- [x] **服务重启实测**：`systemctl restart super-error-log` → active，监听恢复，journal 无异常、无密钥泄漏
- [ ] **回滚演练**：留待下一次版本发布时随发布流程执行（当前仅一个版本 0.1.0，无上一版可切）

部署实测中发现并修复（已写入 deploy/README.md）：① `NoNewPrivileges=true` 会抑制 setcap 文件能力 → Caddy 443 绑定改用 systemd `AmbientCapabilities=CAP_NET_BIND_SERVICE`；② caddy 需穿越数据目录父级 → 父目录 0750 + caddy 入 supererrorlog 组。

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
| **域名/HTTPS** | Caddyfile 固定站点 `study.pccoding666.com`、`disable_http_challenge`、不占 80、admin off；iOS 端拒绝任意域名二维码与携带凭据重定向（单测） | ✅ **已实测**：TLS-ALPN-01 签发成功、证书链 Verify 0 (ok)、443/80 归属 `ss` 确认、`caddy validate` 通过 |
| **授权** | PairingManager 全语义（一次性会话、同 clientId 幂等、并发单胜、30 天令牌、SHA-256 落盘、撤销）；限流四档（配对失败 10/IP/分 + 60 全局、鉴权失败 30/IP/分、已鉴权 300/设备/分）+ 429 Retry-After；伪造 X-Real-IP 不可绕过（集成测试） | ✅ **已实测**（公网）：发码→redeem 200→授权 health 200 六字段；31 连打恰 30×401+429；伪造头不可绕过。真机扫码全流程留待手机侧 |
| **上传** | 15 MiB 上限、4000 万像素边界、400/413 分类；原子容量预约（先预约后解析正文）；`busy` vs `capacity_full` 两种 429；幂等重放 202/冲突 409；磁盘 <3 GiB 拒收；槽位/容量 finally 释放不泄漏（十照片压测 + 集成测试） | ✅ **已实测**（公网）：14MiB 过 Caddy 到应用、16MiB 413 拦截。蜂窝网络真实照片上传留待手机侧 |
| **真实返回** | 中断/重启/显式恢复全链路（集成 + 压测）；attempt 记录与脱敏日志形状 | ⏳ **尚无一次真实百炼调用**——`visionConfigured:true` 已就位，第 1 张真实照片的四方对应留待手机侧 |
| **内容质量** | 证据完整性门槛（canRecover/allChecksPass/occurrence 冲突）全部回归测试保绿；**合成压测明确不评估内容质量** | ⏳ 十张真实照片逐张人工核对（沿用 2026-09-15 验收的严格标准：不漏题、忠实保留原始作答、不误放行） |
| **故障恢复** | interrupted 标记 + 无自动恢复 + 题目级显式 retry（含 409 not_retryable 语义）；磁盘门槛 503；RSS 准入阈值可恢复 | ✅ 服务重启已实测（active、无异常日志、无密钥泄漏）。手机端 interrupted→显式 retry 与断线自愈留待手机侧 |

## 边界与诚实声明

- 本文件所有"通过"均指**本地可执行验证**；域名、TLS、cgroup、真实模型、真机相机各项在部署与真机清单勾选前一律视为**未验证**。
- 压测通过 ≠ 识别质量结论；FixtureVision 一次真实模型都没调。
- 云端模式仍遵守领域铁律：AI 只提取建议、反思必须学生提交、证据核对不过不放行确认/打印。合成测试不触碰真实错题库。
- 部署动作由主控在部署阶段执行（不在本任务自动连服务器）；`deploy/README.md` 是部署的唯一操作手册。
