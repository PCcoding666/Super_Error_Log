# 2026-10-23 六个上线前修复的合并集成（#53 #57 #54 #55 #56 #58）

分支 `claude/p0-integration`，从 `origin/main`（`689e1c9`）开出，按 #53 → #57 → #54 → #55 → #56 → #58 的顺序 `git merge --no-ff`。六个原 PR 与其分支不动。

## 文本冲突（每条一行：文件 · 双方意图 · 解决）

- `src/web/router.ts` import（#57 × #54）：#57 引入 `learningRedoOverview` 与 `attemptDay/intakeDay`（首页到期提示、题目历史锚点）；#54 引入 `materialIntakeSummary`（错题本顶部收录/整理提示）→ 取并集，三者都保留。
- `src/web/router.ts` 错题本数据（#57 × #54）：#57 加 `redo: learningRedoOverview('all')`；#54 加 `materialIntake: materialIntakeSummary(...)` → 两个字段都传给 `ItemsPage`。
- `src/web/views/items.tsx`（#57 × #54）：#57 在标题下放「今天有 N 道题该再做了」`RedoReminder`；#54 放「还有 N 道没收录 / N 张没整理成功 / N 张在整理」提示块 → 两者都渲染，先再做提醒、后收录提示；选题模式下两者都不显示（与各自原意一致）。
- `src/web/router.ts` `POST /settings/grade`（#54 × #55，任务书未列出）：#54 把 `updateStudentGrade` 换成 `chooseStudentStage`（记录已选学段、改学段清筛选 cookie）；#55 在出错重渲染设置页时加 `inviteExpires`（邀请码到期提醒）→ 用 #54 的 `chooseStudentStage` + #55 的 `inviteExpires` 参数。
- `src/studentHost/router.ts` import（#55 × #56）：#55 引入 `AccountPage/PrivacyPage` 与 `ACCOUNT_FLASH_COOKIE`（我的邀请码、隐私规则）；#56 引入 `busyView`（如实的「人有点多」排队页）→ 两组 import 与常量都保留。
- `tests/e2e/studentHost.spec.ts`（#55 × #56）：两边都在同一位置追加新用例（#55：无注册码/未同意被拒与隐私草稿、微信内置浏览器提示、我的邀请码查看/复制/换码；#56：P1-9 Service Worker 原样显示 5xx、离线页只在真断网时出现）→ 四条用例全部保留，原样拼接。
- `src/studentHost/router.ts` 网关初始化（#55 × #58）：#55 把 `LoginThrottle` 换成按码计数的 `AttemptGuard`（登录/注册两套）并加 `now`（滑动会话）；#58 给 `StudentWorkerPool` 传 `sharedDir: registry.hostDir`（全机共用的 AI 回退账本）→ 保留 #55 的两个 `AttemptGuard` 与 `now`，`StudentWorkerPool` 用 #58 带 `sharedDir` 的写法。
- `deploy/ci/README.md` 发布顺序（#56 × #58）：#56 写「空闲检查把 2 小时内有动静的材料整理任务算进去」；#58 写「先清旧备份、服务运行时先打包照片、停服后只打包 SQLite、晚 18–24 点不发布」→ 合成一句，两者的步骤都写进顺序里。`deploy/ci/sel-ci-deploy.py` 本身自动合并，`busy_count()`（#56）与备份/清理（#58）都在，`tests/deploy` 全部通过。

## 合并后 `npm run verify` 的 9 条失败：原因与修法

现象（10/23 01:38 在 UTC+8 本机跑）：只合 #53+#57+#55 时 9 条失败——`materialPrint`（3）、`materialLearning`「keeps delayed independent return rules for material practice」（1）、`practiceSubmission`（2）、`practiceMaterialItems`（2，#53 新增）、`webClient`（1）。

先验证了「#53 让材料题进入真回传 + #57 换延迟锚点 → 测试只拨打印时间，延迟算成 0」这个猜测，**结论是不成立**：

- 在**未改动的 `origin/main`** 上、同一时刻（本地 01:4x）跑这几个文件，同样失败 7 条；只有 #57 的分支失败 7 条；只有 #53 的分支失败 9 条（多出的 2 条是它自己的新测试）。也就是说失败与 #57 无关，也不需要 #53+#57 同时存在。
- 同一合并树用 `TZ=UTC` 跑这 5 个文件：121 条全过。
- 失败的回传逐条报的是「实际作答日期不能早于复习包首次打印日期」，不是 `attempted` 与掌握之间的差别。

真正原因：`recordAttempt` 用**进程本地日历日**校验作答日期（不能早于练习包首次打印日、不能是未来日期），这几处测试却用 `now().slice(0,10)` / `new Date().toISOString().slice(0,10)` 取「今天」，拿到的是 **UTC 日期**。在 UTC+8 的 00:00–08:00，UTC 日期比本地日期早一天，回传被拒，练习包关不上，后面的建包/核对/确认跟着失败。GitHub CI 跑在 UTC，各 PR 作者也在 UTC 的云端跑，所以都是绿的；合并验证恰好在北京时间凌晨跑，才暴露。生产代码没有这个问题（`src/` 里没有用 UTC 日期当「今天」的地方；网页默认作答日用 `localDayText(now, timeZone)`）。

处理：**这 9 条测试不改**（Orchestrator 10/23 决定：时段相关的既有失败不在本 PR 里改测试，写进 PR 说明）。曾提交过一版把这几处改成 `localDayText(new Date())` 的修法（本地/UTC/UTC+14/UTC−7 下都通过），已用 `git revert` 撤回；它可以作为单独的后续 PR。归因：7 条在 `main` 上本来就时段相关（`materialPrint` 3、`materialLearning` 1、`practiceSubmission` 2、`webClient` 1），2 条是 #53 新测试 `practiceMaterialItems.test.ts:73/98` 的同一写法；**没有一条是 #57 新锚点造成的**。因此 verify 用 `TZ=UTC` 跑一次、`TZ=Asia/Shanghai` 跑一次，后者在北京时间 00:00–08:00 运行时会出现这 9 条，08:00 之后应为全绿。

「当天做对不算掌握」和 #57 的锚点（上次作答日，没有就用录入日）都没有改。另核对了任务书点名的风险点：材料来源题由 `syncMaterialLearning` 写入真实的 `error_item` 行（`created_at` = 收录时间），`intakeDay()` 能找到，锚点不会悄悄退回练习包生成日。为把 #53 × #57 的组合行为固定下来，在 `practiceMaterialItems.test.ts` 加了 2 条：从没作答过的材料题以录入日为锚（第 0 天收录、第 3 天建包当天做对 → 暂时掌握）；材料题当天做对只到 `attempted`，隔 3 天以上再做对 → 暂时掌握。把 `intakeDay` 改成找不到材料题时第一条会失败。

## 合并后 Playwright 的 2 条失败（语义冲突，测试侧）

- `tests/e2e/materialPractice.spec.ts`（#53 新增）与 `tests/e2e/materialCapture.spec.ts:508`「another account … does not inherit the pending photos」（#56 新增）：两条都用一个**从没用过的新账号**登录后直接打开拍照页；#54 让新账号首次进入必须先选学段（「初中 / 高中」），所以拍照页被学段页挡住、找不到 `#library-input` / `photo-count`。这是 #54 有意的门槛，#53/#56 写测试时还没有它。修法与 #54 改既有用例的方式相同：登录后先点「初中」，其余步骤与断言不变。

## 集成评审（#55/#56/#58）要求一并改的

- #55 P1 全站/单 IP 失败预算会锁住所有人：登录、注册改为**先验码**，正确的码任何时候都能用；预算只决定「错的那一次」回 429，预算已用完时错误回应再放慢 500 ms（`failureDelayMs`）。注册的全站成功总数上限仍在注册前检查。测试：10 个 IP 刷满 1000 次失败后，正确码从新 IP 和刷过的 IP 都能登录。
- #55 P1 注册限速键是注册码前 4 位：改为「整条注册码哈希 + IP」，`duplicate_registration` 不再计失败。测试：40 人同一 IP 共用注册码，中间 18 次连续打错 + 2 次重复提交（旧规则下第 16 人起被挡）再加 2 次零散打错，40 次正确提交全部 201。
- #58 P1 熔断账本静默退到学生目录：去掉 `SEL_STUDENT_DATA_DIR` 退路，学生 worker 找不到共享账本时拒绝走按量付费并记 `sel_ai_fallback_blocked`（`ledger_dir_missing`）。测试：网关组装的进程池把注册库目录作为共享账本；worker 无共享账本时不调用按量接口。#55 × #58 冲突那一行已核对，保留了 `sharedDir: registry.hostDir`。
- #58 P1 RUNBOOK 顺序：第一次每日备份与恢复演练（新第 9、10 步）挪到删旧发布备份（新第 12 步）和重装发布程序（新第 13 步）之前，并写明前提。
- #55 运维：`check_migrations` 比对 `dist/db` 与 `dist/studentHost/registry.js`，本批 #54（新表）和 #55（注册库 +454 行）都会让自动发布拒绝；合并后第一次上线必须人工发布，人工发布前之后的合并也都会被拒。没有改这道检查。
- #55 P2：删除账号改为删掉目录后才提交（删不掉整笔回滚）；CLI 在目录存在但没有 `registry.db` 时拒绝运行。
