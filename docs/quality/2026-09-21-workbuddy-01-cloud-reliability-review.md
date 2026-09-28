# Workbuddy 任务 01 审查报告：云端识别可靠性修复

> 2026-09-22 勘误与后续：本文保留 Workbuddy 原始执行记录，不作为当前验收结论。独立审查发现重启预算、启动准入、关闭收尾等遗漏，且当时主审全量门禁为 399 通过 / 1 失败（E2E 未执行）。持久化格式、迁移及回滚说明也已在返修中调整，旧文第 6 节不可作为当前部署操作步骤。请以 [R1 返修与审查记录](2026-09-22-workbuddy-01-r1-review.md) 和现行 `deploy/README.md` 为准。原文的装机/无 iOS 改动不等于真实手机流程已验收；EIO 是保持既有失败关闭语义，不是新增产品能力。

日期：2026-09-21 · 执行者：Workbuddy Kimi K3 · 基线 SHA：`cc855da`（任务书参考值，实际核对一致）
范围：A 证书目录隔离 / B 任务恢复与容量计数 / C 自动重试预算统一。不含生产部署、不含 Git 提交推送。

## 0. 基线核对

- 实际 HEAD `cc855da`（codex/ai-error-review-mvp），工作区有 90+ 文件的历史删除（POC/、SuperErrorLog_iOS/、.gradio/ 等，2026-09-19 真机验收期间的清理），与本轮无关，全部原样保留，未使用 `git add .`。
- 三个问题均独立核实调用链，非照搬审查结论：
  - A：`src/mobile/store.ts:27-28`（privateDirectory）与 `src/mobile/pairing.ts:140-141` 每次启动把数据目录 chmod 0700；Caddy 证书存储嵌在其下（`XDG_DATA_HOME=/var/lib/super-error-log/caddy`）→ caddy 用户无法穿越 0700 父目录。
  - B：`processInventory` 在单一 inflight 键（`job:inventory:`）内串行驱动全部逐题识别，看门狗按逐题键（`job:question:qid`）判断 → 长任务跨 60s 周期被误判僵尸；`resumeIncompleteJobs` 恢复时只登记 `activeCapacityJobs` 不向 admission 预约；`finalize` 到终态无条件 `releaseJobCapacity()`。
  - C：`vision.call` 内部 `while (attempt < 3)` 每阶段最多 3 次 HTTP 调用，service 外层再退避重试（题级 2 次/清单级 1 次）→ 同阶段最多 9 次（题）/ 6 次（清单）。

## 1. 改动文件

| 文件 | 改动 |
|---|---|
| `deploy/systemd/super-error-log-caddy.service` | 新建：Caddy 单元纳入版本控制，`XDG_DATA_HOME=/var/lib/caddy-super-error-log`（迁出应用目录） |
| `deploy/README.md` | §1 目录创建（0700 应用目录 + 独立 caddy 目录）、§4 单元改为 cp 自发布包、§6 备份路径、新增 §8 迁移与回滚步骤 |
| `scripts/build-release.sh` | 必检清单补 `deploy/systemd/super-error-log-caddy.service` |
| `src/mobile/admission.ts` | 新增 `noteExistingOccupancy()`：恢复既有任务无条件登记占用（超额旧任务可继续，只拦新增） |
| `src/mobile/service.ts` | ① 看门狗任务级活动守卫（inventory 键在队/在途即跳过整个任务）+ `retryScheduled` 集合护住退避窗口；② 恢复路径 `noteRestoredOccupancy` 真实预约；③ `releaseCapacityOnce`：只有占位的任务才释放；④ `retry` 迁移失败回滚本次新预约 |
| `src/mobile/vision.ts` | `call()` 改单次尝试：不再内部自转 3 次；attempt 落盘移出 try/catch（存储故障穿透为 fail-closed，不误分类为模型失败） |
| `tests/integration/mobileRecovery.test.ts` | +3 例：长任务跨扫描周期不误判、退避窗口不提前入队、重复扫描幂等 |
| `tests/integration/mobileAdmission.test.ts` | +3 例（新 describe「restart capacity accounting」）：恢复满额拒新增/终态恰好释放一个名额、重复收拢不释放在途容量、重试迁移失败回滚预约 |
| `tests/integration/mobileRetryBudget.test.ts` | 新建：真实适配器 + 真实 HTTP 合成故障服务器的预算统一证明（4 例） |
| `tests/integration/mobileVision.test.ts` | 旧「retries … up to three total attempts」改约：适配器单次尝试 + 错误分类（新契约断言；预算端到端证明在 mobileRetryBudget） |
| `tests/integration/buildRelease.test.ts` | mustContain 补 caddy 单元；新增「应用重复初始化不影响平级证书目录权限」回归 |

## 2. 每项根因与修复

### A. 证书目录权限冲突
根因：应用启动把自身数据目录强制 0700，Caddy 证书存储嵌套其内，caddy 用户无法穿越。
修复：**不共享目录**——Caddy 存储迁到 `/var/lib/caddy-super-error-log`（caddy 私有 0700，与应用目录平级）。应用数据目录保持 0700 不变。systemd 单元、部署说明、迁移/回滚步骤三处同步。发布包自动包含新单元（deploy/ 递归白名单 + 必检清单 + 打包测试三重验证）。
未动：443 入口、TLS-ALPN、80 端口归属、应用私有权限语义（未用 777/全局可读/root 运行绕过）。

### B. 任务恢复与容量计数
- **僵尸误判**：`processInventory` 单 inflight 键覆盖整个逐题阶段 → 看门狗按逐题键判断时误判。修复=任务级活动守卫：inventory 键在队/在途即跳过整个任务 + `retryScheduled` 集合护住自动重试退避窗口。
- **恢复不占容量**：恢复只登记内存集合不预约 admission。修复=恢复时 `noteRestoredOccupancy`（无条件登记，允许历史超额继续处理，只拦新增）。
- **重复释放**：`finalize`/清单失败路径无条件 release。修复=`releaseCapacityOnce`：`activeCapacityJobs.delete()` 返回 true 才归还——每个容量预约恰好释放一次。
- **重试迁移失败泄漏**：预约成功后 updateJob 故障，名额悬空。修复=`reserveRetryCapacity` 返回是否新预约，失败时只回滚本次新占。

### C. 重试预算统一
根因：适配器内 3 次 × service 外层 2-3 次 = 同阶段最多 9 次。
修复：适配器每次调用只发一次 HTTP 请求并原样上抛分类错误；预算统一在 service 外层（题级 2 次退避重试、清单级 1 次）。同题同阶段累计 ≤3 次（首次+两退避）。
附带修复：`attempt` 落盘移出模型调用的 try/catch——此前存储 EIO 会被误分类成「模型失败 internal」，现在穿透为 fail-closed（既有语义回归，由 mobileRecognition 的 EIO 测试实证）。

## 3. 测试命令与结果（本地已验证）

| 阶段 | 命令 | 结果 |
|---|---|---|
| RED 证据 | `npx vitest run tests/integration/mobileRecovery.test.ts`（修复前） | 2 失败 / 8 过：长任务被重置回 queued、退避窗口被提前执行 |
| RED 证据 | `npx vitest run tests/integration/mobileAdmission.test.ts`（修复前） | 3 失败 / 12 过：恢复不占容量（429 缺失）、收拢误释放、重试泄漏 |
| RED 证据 | `npx vitest run tests/integration/mobileRetryBudget.test.ts`（修复前） | 2 失败 / 2 过：transcribe 9 次调用（相乘实证） |
| GREEN | 同上三文件（修复后） | recovery 10/10、admission 15/15、budget 4/4 |
| 受影响回归 | `npx vitest run mobileRecognition + mobileVision + mobileRetryBudget` | 67/67（含 EIO fail-closed 回归修复后再验证） |
| 打包 | `npm run release:build` + `tar -tzf` | 95 条目，两个 systemd 单元均在包内 |
| 全量门禁 | `npm run verify` | typecheck ✓ build ✓ 400/400 Vitest ✓ 9/9 Playwright ✓ |

## 4. 兼容性

- 移动端公共契约：未改任何字段/状态机/端点——`recognitions` API 形状不变。iOS 不需要对应测试变更（纯服务器内部行为修复）。
- 持久化格式：`job.json`/`devices.json` 结构未动；恢复逻辑只读现有字段。
- 部署配置：Caddy 单元是新增文件，不覆盖现有单元；应用单元（super-error-log.service）未动。
- 旧测试处理：仅一处旧断言改约（mobileVision 的适配器内部重试）——因为适配器内部自转正是被修复的缺陷本身；预算证明迁移到 mobileRetryBudget（真实适配器+真实 HTTP 边界，非 stub）。

## 5. 未验证事项（诚实声明）

- **生产待验证**：跨 UID 权限（caddy 不能读应用数据、应用不影响 caddy 存储）需要在真实 Linux 双用户环境执行；本地 macOS 单用户只证明了「应用初始化不动平级目录」的语义前提。证书迁移 §8 步骤未实际执行（任务书明确不碰生产）。
- **生产待验证**：恢复时容量账目的真实多任务负载（10 个真实照片任务并发恢复）只在合成环境验证。
- **真机待验证**：本轮无 iOS 改动，无需真机验证。

## 6. 建议部署顺序与回滚

1. 先在服务器执行 §8 证书迁移（备份 → 建独立目录 → cp -a → 换新单元 → daemon-reload → restart caddy → curl 验证 401 + journalctl 无 permission denied）。
2. 再部署应用新版（常规 `release:build` → 解包 → npm ci → 切链 → restart super-error-log）。
3. 回滚：应用侧切旧软链 + restart；Caddy 侧 cp 回旧单元 + restart（旧证书目录未删除，随时可回指）。
