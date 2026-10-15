# M1 使用中的状态引导 · iOS 正式实现计划（两周学生试用版）

日期：2026-09-27。执行：kimi-k3（代码+测试）；Codex：独立审查 + 装机。依据：`docs/superpowers/specs/2026-09-27-student-state-guidance-design.md`（R1/R2 修订版）+ r1–r4 原型验收结论。**用户最新要求优先**：确认不强制打开全屏原图（页内可读可缩放即可）、确认后给「继续下一道 / 去复盘本题」双出口、不强迫逐题复盘、不加首启教程。

## 范围

只改 `iOS/`（StudentApp 视图、StudentCore Domain、Tests、UITests）+ 本文件 + 验收报告 `docs/quality/2026-09-27-iphone-pilot-m1-review.md`。不改后端 `src/`/`tests/`(TS)/`deploy/`，不提交/推送/部署/装机，不碰密钥/私人照片/生产数据/真实模型。

## 实现项（对应设计稿 M1）

1. **聚合逻辑落地为可测纯函数**（新文件 `iOS/StudentApp/Domain/TaskPresentation.swift`，随 Domain 进 StudentCore target）：
   - `photoCard(task:) -> PhotoCardPresentation`（tone/headline/counts/nextStep/actionable）：严格规则——零候选完成≠全部确认、零候选处理中=「仍在定位」、全跳过、全失败、confirmed+failed、ready+processing（可先核对）、未知 status=「状态需核对」、全部 confirmed 才绿。计数常显，「已处理」含失败。
   - `nextActionableQuestion(in:after:)`：确认后「继续下一道待处理」的选择逻辑（按列表顺序、跳过当前、只认 ready/needs_check）。
   - `RefreshIssue`（offline / serviceUnavailable / unauthorized / unknown）+ 从 Error 分类的纯函数。
2. **StudyStore**：`LocalRecognitionTask` 增加可选 `lastIssueKind`（decodeIfPresent 兼容旧档）；`refreshJobs` 失败时分类写入、成功清除；不新增任何写接口、不改契约。
3. **本周页（ThisWeekView）**：照片卡整卡可点进同一任务（NavigationLink 包整卡；仅本机未上传的卡保持勾选语义）；卡上显示语义色 chip + 真实计数 + 一句下一步；顶部「下一步」摘要条（有待办才橙色可点，仅在无待办、无在途、无未知时绿色）；VoiceOver 标签读「照片 N，状态，下一步」。
4. **题目详情（RecognitionQuestionView）**：
   - 页内嵌入可读原图（复用 `ZoomablePhoto`，固定高度容器内双指缩放/平移），解码成功才算「来源可看」；「查看完整原图并对照」全屏查看器降级为可选放大入口。
   - 确认门禁改为：**来源原图真实解码显示 + 必要图示本机可读 + 学生明确勾选**；不再用「打开过模态框」布尔。revision/同号冲突/缺失媒体/未解决疑问拦截全部保留（走现有 `canAccept` 与 confirm 前置校验）；needs_check 仍只有人工放行（同样要求原图真实可读），不开放普通确认。
   - 确认成功后停在原页，出现双出口：「继续下一道待处理」（有则换题，back 仍回题目列表）与「去复盘本题」（sheet 呈现现有 ReflectionFlow，复用 tab 绑定）。
   - 云端模式下连接非 ready 时禁用确认/放行/重试并给一句原因；回环模式行为不变。
5. **视觉基础设施**：Palette 改动态颜色（light/dark 双套），移除 `preferredColorScheme(.light)`；卡片白底改 `Palette.card`；触控目标 ≥44pt；不改字体体系（已是 text style，天然支持动态字号）。不加依赖、不加语音/归类假按钮。

## TDD 顺序

- RED：`iOS/Tests/TaskPresentationTests.swift`（聚合七态 + nextActionable + RefreshIssue 分类）；`StudyStoreRegressionTests` 增 1 例（刷新 500 → lastIssueKind=serviceUnavailable 且缓存保留）。
- GREEN：实现 TaskPresentation + StudyStore 分类。
- 视图接线后跑既有 `swift test` 全量。
- UI 旅程：改 `LiveRecognitionJourneyTests` 中受门禁语义变化影响的两处（needs_check 放行不再依赖模态框开启；确认路径改走页内原图），新增 M1 旅程（整卡点击、确认后双出口）。先 build 现有目标再跑。
- 全仓 `npm run verify`。

## 验证与证据

- `swift test`、`xcodebuild build`（现有 Manual 流程）、UI 旅程 xcresult 存 `iOS/build/ui-m1-<唯一>-*.xcresult`；日志存同目录唯一文件名。
- 报告列：真实输出摘要 / 未验证项 / 仍阻碍真实学生使用的问题（识别修正出口、纸面回传、签名持续性——只列未知不操作）。
