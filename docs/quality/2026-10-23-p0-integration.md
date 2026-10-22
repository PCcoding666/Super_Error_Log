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

见本文件下一节（集成后补充）。
