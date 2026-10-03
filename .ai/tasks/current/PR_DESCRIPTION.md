# PR DESCRIPTION（草稿，Phase 6 定稿）

## 背景
将 Super Error Log 从旧 Flask/iOS/POC 实验代码库重建为面向初三住校生的「周末数字化 + 工作日纸质复习」MVP。旧实现 132 文件已删除，15 个敏感文件隔离未读。

## 范围
TypeScript 全栈从零实现完整闭环：批量上传（去重/EXIF/边界分类）→ mock/真实 AI 提取（低置信人工校正）→ 学生四项最小反思（AI 不得代写）→ 可解释选题（0–100 分 + 理由）→ A4 黑白打印 PDF（题目/答案分离、演算区、勾选框）→ 回传（独立/提示/做错/未完成）→ 掌握状态机（延迟独立重做才算掌握）→ 趋势与家长聚合视图。

## 关键设计
- AI 解耦：Provider 契约 + 确定性 mock（manifest/哈希派生/故障注入），无 Key 全流程可跑
- 幂等：内容哈希跨批次去重、`INSERT OR IGNORE`、重试不重复建题
- 权限：`sel_role` Cookie + requireStudent 中间件；家长仅聚合查询，页面/API/媒体三层隔离
- 掌握模型：当场做对 ≠ 掌握；3–7 天延迟独立做对 → 暂时掌握；7–14 天确认 → 稳定掌握
- PDF：Playwright Chromium 服务端渲染 A4；pdf-lib/pdfjs 程序化校验尺寸与答案分离
- 零原生依赖 DB：node:sqlite（WAL）；每测试 worker 独立临时数据目录

## 测试证据
- 单元 33/33、集成 23/23、E2E 9/9（J1–J8）、typecheck/build 通过
- 验证报告：docs/PRODUCT_VALIDATION_REPORT.md（含过程中修复的 5 个问题）

## 风险
- R1/R2：旧 git 历史中疑似 secret 残留（见 RISK_REGISTER，需所有者处置）
- 真实 AI 模式与真实打印未冒烟（列入 RELEASE_CHECKLIST）

## 非目标
多学生/多家庭、账号体系与云同步、iOS 客户端、真实 OCR/VLM 调优、工作日屏幕功能。

## 人工审查清单
- 打印一份生成 PDF 目检版式
- 家长态逐页确认无题目/反思泄露
- 设置页清空数据后确认目录清空
