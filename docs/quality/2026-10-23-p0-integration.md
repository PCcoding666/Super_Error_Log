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

修法（只改测试输入，不动断言）：这几处改用 `src/domain/calendarDay.ts` 的 `localDayText(new Date())`，即与 `recordAttempt` 同一口径的本地日历日；同类的 `practiceTasks.test.ts` 一处（断言的是「已取消」，当前不受影响）也一并改。改后在本地（UTC+8 凌晨）、`UTC`、`Pacific/Kiritimati`（UTC+14）、`America/Los_Angeles` 下这 6 个文件 132 条全过。

「当天做对不算掌握」和 #57 的锚点（上次作答日，没有就用录入日）都没有改。另核对了任务书点名的风险点：材料来源题由 `syncMaterialLearning` 写入真实的 `error_item` 行（`created_at` = 收录时间），`intakeDay()` 能找到，锚点不会悄悄退回练习包生成日。为把 #53 × #57 的组合行为固定下来，在 `practiceMaterialItems.test.ts` 加了 2 条：从没作答过的材料题以录入日为锚（第 0 天收录、第 3 天建包当天做对 → 暂时掌握）；材料题当天做对只到 `attempted`，隔 3 天以上再做对 → 暂时掌握。把 `intakeDay` 改成找不到材料题时第一条会失败。
