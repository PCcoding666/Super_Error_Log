# 计划：needs_check 题目人工放行通道（人工确认旁路）

日期：2026-09-20 · 分支：codex/ai-error-review-mvp · 流程：TDD（RED→GREEN）+ 独立审查
触发：真机体验实证——300D31DF（12 题里 9 题 needs_check）和 118FA663（15 题里 8 题 needs_check）中，「有内容需核对」的题没有任何放行路径，既不能确认也不能修正，只能挂着，形成死胡同。

## 0. 问题与目标

**问题**：`service.ts` 的 `confirm` 只允许 `status=='ready'` 的题被确认；needs_check 的题（AI 自检没把握，但学生人工看原图后确认没问题）永远卡死。这违背「AI 提取建议、学生拍板」的领域原则——AI 没把握时不该剥夺学生的最终拍板权，只是必须让学生**显式声明这是人工放行**，且留下可审计痕迹。

**目标**：给 needs_check 题加一条人工放行通道：服务器接受 `sourceCompared=true` 的 confirm（该字段本来就要求打开过原图），在题上打上 `manualRelease=true` 标记并加一条 issues 说明；ready 题的原路径完全不变；iOS 端在 needs_check 卡片提供「我已对照原图，放行这道题」按钮（带确认弹窗）。

## 1. 不变量（领域规则，不可放松）

- AI 只提取建议——人工放行是学生主动、显式、留痕的决定；
- 已确认（confirmed）的题不受影响；ready 题的正常确认路径（需要五项全过+无 issues+无 uncertainties）完全不变；
- 人工放行不抹掉 verify 的 issues——它们是「AI 当时没把握」的证据，保留供家长/回顾参考；
- 人工放行只放行本题（question 级），不触发重跑；不占模型调用。

## 2. Task 1：服务器端 confirm 支持 manualRelease（RED→GREEN）

**RED**（`tests/integration/mobileRecognition.test.ts` 追加）：
1. needs_check 题 + `action:'confirm'` + `sourceCompared:true` + `manualRelease:true` → 200，status 变 confirmed、confirmedAt 非空、issues 里多一条人工放行记录；
2. needs_check 题 + confirm 但**缺 manualRelease** → 仍 409（原行为不变，防止误放行）；
3. needs_check 题 + manualRelease 但 `sourceCompared:false` → 409（没看原图不放行）；
4. ready 题 + manualRelease:true → 仍走原路径（不产生人工放行标记——ready 本来就能确认）。

**GREEN**（`src/mobile/service.ts` 的 confirm 方法）：
- 分支：若 `input.manualRelease === true` 且 `question.status === 'needs_check'` → 要求 `sourceCompared===true`，不再要求 allChecksPass；置 confirmed/confirmedAt，写 `manualRelease` 字段（`RecognitionQuestion` 加 `manualRelease?: boolean`），并向 verification.issues 追加「人工放行：学生已对照原图确认本题（AI 未通过完整性核对）」；
- 其余路径不动。

**门禁**：`npm run typecheck && npm run build && npm run test`。

## 3. Task 2：iOS 端 needs_check 卡片增加放行按钮（RED→GREEN）

**RED**（`iOS/Tests/` 或现有 UITests 用合成服务器加一例）：
- needs_check 题卡片显示「我已对照原图，放行这道题」按钮；点击弹确认；确认后调用 act(manualRelease: true)；题状态变 confirmed。

**GREEN**（`iOS/StudentApp/RecognitionView.swift` 的 RecognitionQuestionView）：
- needs_check 分支下（现有「保留待核对，稍后再看」按钮旁），若 `hasCachedDiagrams` 且 `originalOpened`（打开过完整原图），显示确认弹窗 + 放行按钮；
- StudyStore.act 增加 `manualRelease: Bool = false` 参数透传到 client.confirm；
- RecognitionClient.confirm 请求体加 `manualRelease` 字段。

**门禁**：`swift test` + 真机/模拟器 UI 测试（现有 9 项全过）。

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| 学生无核对乱点放行 | 必须打开过完整原图（originalOpened）+ 确认弹窗文案明确「AI 没把握，你确认无误吗」；issues 保留痕迹，家长可在打印页看到该题是人工放行 |
| ready 题被误标人工放行 | manualRelease 仅在 status=='needs_check' 时生效；ready 走原路径 |
| 契约破坏旧版本 iOS | manualRelease 是可选字段，旧版本不解码也正常；服务器不强制 |
| 测试并发 | confirm 已有并发单胜测试，人工放行复用同一 revision 校验 |

## 5. 完成定义（DoD）

- [x] 服务器 Task 1 RED→GREEN（mobileRecognition 31/31），门禁全绿：typecheck / build / 389 Vitest / 9 Playwright
- [x] iOS Task 2 完成，swift test 51/51，UI 测试通过（含新增「人工放行解锁」与强化的「未看原图不显示放行按钮」）
- [x] 部署 0.1.1-manual-release 到服务器（grep 实证 dist 含 manualRelease 分支；契约向后兼容）
- [ ] 用户真机验证：118FA663 那张照片的 8 道 needs_check 题里任意一道，可走完「对照原图→放行」流程变已确认（**需要新装手机 App**——当前手机装的是 9-20 早上的构建，还没有放行按钮；iPhone 连线后跑 `xcrun devicectl device install app` 即可）
- [x] 审查归档（.superpowers/sdd/2026-09-20-manual-release/task1-review.md），推送 GitHub（e163da6）
