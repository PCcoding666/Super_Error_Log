# 计划：识别坐标回归修复（0–1000 对角点原生格式）

日期：2026-09-20 · 分支：codex/ai-error-review-mvp · 流程：TDD（RED→GREEN）+ 独立审查
依据：`docs/quality/bbox-experiment-20260920/REPORT.md`（9 次真实 API 调用对照实验，归因修正版）

## 0. 背景与目标

真机验收（job e2121b77，qwen3.8-max）中 questionCropComplete 失败率 50%。对照实验证明：模型在 0–1000 对角点整数（Qwen-VL 原生坐标词汇）下输出稳定（x1 三次 0.19±0.002）、题干裁图完整；在 0–1 小数 xywh（当前管线格式）下漂移显著。生产管线已全局发送 `enable_thinking:false`（chatClient.ts:99），思考模式不是变量。

**目标**：transcribe/ground/inventory 三阶段的坐标请求与解析切换到 0–1000 对角点整数格式，带制式判别兜底与坐标后处理，使真实照片的 cropComplete 失败率从 50% 降到可用水平（<10%），且全部现有门禁（357 Vitest + 9 Playwright + swift 51）保持绿色。

**不变量（领域规则，不可放松）**：
- AI 只提取建议；证据核对不过不放行确认/打印；
- 服务端 API 契约（0–1 xywh 的 questionRegion/candidateBox）**不变**——0–1000 只存在于「模型对话层」，进入存储/契约层前统一换算为 0–1；
- iOS 端渲染、PDF 裁剪、store 持久化格式全部不动。

## 1. 范围

改：`src/mobile/vision.ts`（BOX 提示词、EVIDENCE_CONTRACT 坐标段、validateInventory/validateCandidateEvidence 解析）、`src/ai/evidence.ts`（validateBox 入口前置制式判别换算，或新增 decodeModelBox 工具函数）。
不改：`src/mobile/service.ts`、`store.ts`、`contracts.ts`（publicJob 输出仍 0–1）、iOS 全部、chatClient.ts。

## 2. Task 1：模型层坐标词汇切换 + 制式判别（RED→GREEN）

**RED**（新测试文件 `tests/integration/mobileVisionBoxFormat.test.ts`，复用 mobileVision.test.ts 的本地 HTTP 假服务器模式）：
1. transcribe 阶段假服务器返回 0–1000 对角点 Evidence（`"questionRegion":{"x1":192,"y1":148,"x2":850,"y2":183}` + regions 同格式）→ 断言管线产出 0–1 xywh 的 Evidence（x=0.192, y=0.148, width=0.658, height=0.035）且 questionCrop 实裁成功；
2. 模型混用制式（x1=192 但 width=0.5 这种混合）→ 断言按制式判别规则正确归一（每字段独立判别：值 >1 判 0–1000，≤1 保持）；
3. 假服务器返回传统 0–1 xywh（旧格式）→ 断言仍正常解析（向后兼容，过渡期模型可能仍回旧格式）；
4. 对角点越界（x2=1050）→ 断言钳制到 1 后按比例换算，不抛 invalid_output（区别于现状的硬失败）；
5. 提示词断言：capture 发出的 messages 文本包含「0到1000」与「x1,y1,x2,y2 对角点」字样，不再包含「0到1比例坐标」。

**GREEN**（实现，全部在 `src/mobile/vision.ts` + `src/ai/evidence.ts`）：
- BOX 常量改为：`所有框均为转正后完整原图上的0到1000整数对角点坐标{x1,y1,x2,y2}，左上角与右下角。`；EVIDENCE_CONTRACT 的 questionRegion/regions box 示例同步改为对角点示例；
- 新增 `decodeModelBox(raw: Record<string, unknown>): Box`：读 x1/y1/x2/y2（或兼容旧 x/y/width/height）；每字段独立判别制式（>1 → /1000；≤1 → 原值，但字段组合矛盾时——同框内既有 >1 又有 ≤0.5 的可疑混合——统一按 0–1000 整组换算）；输出 0–1 xywh；钳制 [0,1]；
- validateInventory/validateEvidence 的 box 入口全部走 decodeModelBox（旧 validateBox 保留给契约层直入路径）；
- ground 阶段提示词的「坐标只参照第1张完整原图」段落同步更新坐标词汇描述。

**门禁**：`npm run typecheck && npm run build && npm run test`（新测试 RED 时失败、GREEN 后通过；旧 mobileVision.test.ts 全部保持绿——它的假服务器返回 0–1 xywh，兼容路径覆盖）。

## 3. Task 2：坐标后处理（候选框融合 + 钳制）

**RED**（同文件追加）：
1. transcribe 返回的 0–1 框与候选框 IoU<0.1（疑似定位漂移）→ 断言记录 warning 进 verification.issues（不静默替换，保持「AI 建议可核对」原则）；
2. 返回框越界（x+width>1）→ 钳制后仍产出可裁剪的框（不再 invalid_output 硬失败——这正是 9-18 27b 第 12 题的失败模式）；
3. 高度异常膨胀（>候选框 3 倍）→ 钳制到候选框高度的 2 倍并记 warning。

**GREEN**：在 decodeModelBox 之后、renderCrops 之前加后处理函数 `reconcileBox(modelBox: Box, candidateBox: Box): { box: Box; warnings: string[] }`（纯函数，放 vision.ts 导出供测试）。

**门禁**：同 Task 1。

## 4. Task 3：真机回归验证（真实照片）

- 用服务器现存两张真实照片（job 798ef1c8 的 A6132DE8、job e2121b77 源图）通过管理端重跑（重拍或按题重试已失败题），对比修复前后 cropComplete 通过率；
- 用户 iPhone 再拍 1 张新照片走完整链路（配对→蜂窝同意→上传→核对）；
- 通过标准：新照片 cropComplete 失败 ≤10%，needs_check 题 verify issues 无「截断/混入邻题」类坐标错误；
- 结果回写 `docs/quality/2026-09-17-cloud-recognition-acceptance.md` 真机清单。

## 4b. Task 4：裁图边距扩展（锚定问题的确定性修复，2026-09-20 增补）

Task 3 中期报告暴露「锚定」新失败模式：模型框与候选框逐字段一致，旧随机漂移的意外放大消失，紧凑候选框导致裁图截断（缺印刷题号、缺第二行）。用户拍板方案 B：服务端确定性边距扩展。

**设计**（裁图时刻变换，不写回证据——AI 提建议、学生核对的不变量不动）：
- 左右各 +6% 框宽（页宽钳制 [1%, 3%]）；上下各 +20% 框高（页高钳制 [0.4%, 1.2%]）；
- 系数依据：题号 "7." 需 ≈3% 页宽；一行文字 ≈1.2% 页高（300D31DF 实测）；web 管线先例 expandCropBox 25%/25% 收紧而来（verify 会复核邻题污染，过宽风险由闭环纠回）；
- 只作用于题目裁图（questionCrop）；图示裁图不扩展；边距永不复合（grounding 回声裁图=单次扩展，有回归测试）。

**RED→GREEN**：3 组测试（扩展且证据框不变、页边钳制、grounding 不复合）先红后绿；2 个旧测试的期望裁图同步应用 expandCropMargin。

**审查**：`.superpowers/sdd/2026-09-20-bbox-format/task4-review.md`——无 F1 缺陷；F2×2 核对闭环；边界对抗探测（全页框/退化窄条）全过。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 模型偶尔仍回 0–1 旧格式 | decodeModelBox 双格式兼容 + 5 组新旧格式测试 |
| 制式判别歧义（0.5 可能是两种制式） | 字段组合矛盾规则 + 与候选框 IoU 校验兜底（Task 2） |
| iOS 端或 PDF 受影响 | 契约层不动（publicJob 已删内部字段，输出 0–1），E2E J1–J9 全跑 |
| 假服务器测试不覆盖真实模型行为 | Task 3 真机回归是验收关 |

## 6. 完成定义（DoD）

- [x] Task 1 RED 测试 5 组全部先红后绿（实际 7 组：计划 5 + 审查发现 2 组回归守护；审查报告 `.superpowers/sdd/2026-09-20-bbox-format/task1-review.md`，F1×2 已闭环）
- [x] Task 2 RED 测试 3 组全部先红后绿（审查报告 `.superpowers/sdd/2026-09-20-bbox-format/task2-review.md`，F1 陈旧警告 + F2 测试隔离已闭环）
- [x] Task 4（增补）RED 测试 3 组先红后绿（审查报告 `.superpowers/sdd/2026-09-20-bbox-format/task4-review.md`，无 F1；裁图边距扩展上线）
- [x] 全量门禁绿：typecheck / build / 381 Vitest / 9 Playwright（Task 4 后：378+3 新增；stressTenPhotos 并行墙钟超时为负载假失败，单独复跑全过）
- [ ] Task 3 真机回归：新照片坐标类失败 ≤10%（**未达成，且在这两张照片上结构性不可达**：300D31DF 有 5 题物理右缘截断（上限 62% ready）、A6132DE8 有 3 题紧凑列候选重叠（上限 50% ready）。Task 4 边距修复已交付并验证：同图重跑 ready 4→7（A613 1→3、300D 3→4），Q7 题号回收实证左边距设计正确。剩余失败分类与下一步选项见 `.superpowers/sdd/2026-09-20-bbox-format/task4-regression.md`；达成该目标需要外部条件改变：重拍 300D31DF（含右列）或做 inventory 行切分（方向 C））
- [x] 实验报告已归档（task1/2/4-review + task3-interim + task4-regression），计划勾选，会话结束统一推送 GitHub（已推 07dba2f，无强推）
