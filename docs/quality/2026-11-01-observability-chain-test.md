# 可观测性：本地全链路测试与改造记录（2026-11-01）

目的：回答「学生线上出了 bug，能不能靠日志查出来」。方法：在本机起真实的邀请码网关 + 真实 fork 的合成识别 worker（和 `tests/e2e/studentHostServer.ts` 同一装配，`SEL_STUDENT_WORKER_FAKE=1`，不调真实模型），把主进程 stdout/stderr 收进一个文件当作 journald，用 curl 和桌面端内置浏览器把学生流程走一遍，再注入故障，对照日志。合成数据、合成账号，没有碰生产和真实学生数据。

## 一、改造前：学生做了什么，日志里看得到什么

走过的流程：未登录打开 → 错码登录 → 正确登录 → 拉起 worker → 选学段 → 上传照片 → 轮询录入态 → 勾选候选题 → 错题本 → 详情 → 题图 → 改分类。故障注入：不存在的题（404）、坏 JSON（400）、跨站 POST（403）、伪造会话 cookie（401）、不存在的接口（404）、坏图片（400）、`kill -9` worker 后立刻请求、上传进行中杀 worker。

| 发生的事 | 主进程日志（journald） | 学生目录 `events.log` / `audit_event` |
|---|---|---|
| 正常流程全部 11 步 | **一行都没有** | 每步一行 `web_view` / `web_submit`，但没有耗时、没有请求 ID |
| 错码登录 400 | 没有 | 没有（网关层拒绝，不到 worker） |
| 伪造会话 401、跨站 403、被拒路径 404 | 没有 | 没有（同上） |
| worker 第一次拉起（0.77 s） | 没有 | 没有 |
| worker 被 `kill -9` | 一行 `sel_worker_error`（只有学生前 8 位和信号） | 没有 |
| 下一次请求自动重拉（0.5 s 内 200） | 没有（看不出发生过重启） | 新设备 ID 的 `web_view` |
| worker 内 404 / 400 | 没有 | `web_error /s/items/:id#404`、`/s/items/discard#400`、`/s/capture#400:unreadable` |
| worker 内 500（读代码） | 裸 `console.error(error)`：有栈、没路由、没学生、没请求 ID | `web_error …#500` |
| 浏览器里的脚本错误、fetch 没发出去、上传在浏览器里失败 | 没有（控制台里有两条错误，服务器一无所知） | 没有 |

结论：每个学生自己的 `events.log` 能回答「他点到哪一步」，但散在每个学生目录里、没有耗时和请求 ID；网关这一层（登录、会话、转发、worker 生命周期）几乎全静默；浏览器端完全是盲区；三边没有任何编号能对上。生产机上的 Caddy 也没开访问日志（隐私考虑，配对链接里的一次性码不落日志）。

## 二、改了什么

三个提交，都在 `codex/observability-request-trace`：

1. `feat(observability)`：`src/observability/log.ts` 一行一条 JSON（`event` / `level` / `at` + 元数据）写 stderr；网关每个请求生成 12 位请求 ID，响应头 `x-sel-request-id` 回给浏览器、内部头交给 worker；访问日志 `sel_http`、登录 `sel_login`、转发失败 `sel_proxy_error`、worker `sel_worker_start` / `sel_worker_stop`；worker 侧 500 记 `sel_request_failed`，JSON 与页面带「错误编号」。
2. `feat(client)`：浏览器端 `report.ts` 上报脚本错误 / 白屏 / 上传失败 / 接口异常 / 安卓壳吞选择器到 `/s/api/client-log` → `sel_client_event` + 互动记录；`ErrorBoundary`；页面显示错误编号；客户端构建号。
3. `feat(ops)`：巡检新增三项告警；RUNBOOK「学生说出问题了怎么查」；隐私文档与客户端文档。

记什么、不记什么：只有请求 ID、方法、路由模板（题目 / 照片 ID 换占位符）、状态码、耗时、学生 ID 前 8 位、浏览器家族、拒绝原因 / 错误码、错误类名与截短消息。登录结果带 IP。不记题目、照片、姓名、手机号、邀请码、令牌、cookie、原始 User-Agent、查询串。集成测试断言日志全文里没有学生 ID 全文、邀请码、会话令牌。

## 三、改造后同一链路看到的东西

同一套流程重跑（curl + 内置浏览器）：

- 每个请求的响应头都有 `x-sel-request-id`；404 的题在页面上显示「错误编号 rbg67jxw7gv6」，journald 里对应一行 `{"event":"sel_http","level":"warn","rid":"rbg67jxw7gv6","method":"GET","route":"/s/api/items/:itemId","status":404,"ms":3,"student":"c397254c","code":"not_found","ua":"desktop"}`。
- 在页面里人为抛一个脚本错误和一个未处理的 Promise 拒绝：1.5 秒后 journald 里两行 `[worker c397254c] {"event":"sel_client_event","level":"error","kind":"script_error",…,"build":"local.2610311758","ua":"desktop"}`，学生目录 `events.log` 里两行 `web_error /s/q/:id#client:script_error:Error`。
- `kill -9` worker：`sel_worker_error`（SIGKILL）之后紧跟 `sel_worker_start`（`ms` 拉起耗时、`live` 存活数）。
- 错码登录：`sel_login` `outcome=invalid_code` 带 IP；伪造会话：`sel_http` `status=401 reason=session_invalid`；跨站：`reason=cross_site`。

## 四、验证范围

- 单测 `tests/unit/observabilityLog.test.ts`（日志形状、截短、请求 ID、UA 家族、错误摘要），`tests/unit/opsScripts.test.ts` 新增巡检计数与分组。
- 集成 `tests/integration/studentHostTrace.test.ts`（真实网关 + 合成 worker）：请求 ID 贯穿、拒绝原因、404 错误码、崩溃与重拉、上报接口、关闭时的预期退出；日志里没有敏感值。
- 本机内置浏览器：登录 → 选学段 → 首页 → 404 详情页显示错误编号 → 注入脚本错误后日志与互动记录都有。
- `npm run verify` 结果见 PR。

没有验证的：生产机上的 journald 容量与 `journalctl` 实际检索（估算一个活跃学生一天几百行）；真实手机（iOS Safari / 微信 / 安卓桌面壳）的上报是否都能发出（`sendBeacon` 在关页时的行为各浏览器不同）；`sel_proxy_error` 的 `upstream_timeout` 分支只有代码阅读，本地没有构造 120 秒超时；原生 App 路径（`/s/native`）只跑了集成测试里的转发，没有真机。

## 五、顺带发现

- `tests/integration/webClient.test.ts`「整份照片提交保留多页…」在北京时间 0–8 点失败：测试用 UTC 日期当「今天」，服务器按本地日期判断，另一次提交里改成本地日期。与可观测性改造无关，在 `origin/main` 上同样复现。
- 内置浏览器里打开 `/s/` 时控制台有两条「An unknown error occurred when fetching the script」，不影响使用；来源待查（可能是浏览器壳自己注入的脚本）。现在这类错误会以 `script_error` 上报到服务器，上线后看 `sel_client_event` 里有没有真实学生碰到。
- 生产目前仍是 #87（`e28aa1b`）；#85 改了 `dist/db` 被自动发布的迁移保护拒绝，本分支合并后同样要等人工发布（见 `docs/quality/2026-11-01-manual-release-4806d18.md`）。
