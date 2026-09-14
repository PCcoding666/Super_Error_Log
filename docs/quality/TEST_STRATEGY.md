# 测试策略

## 分层

| 层 | 工具 | 范围 | 现状 |
|---|---|---|---|
| 单元 | Vitest | 纯领域逻辑：状态机、评分、排期、mock Provider 确定性 | 33 例 |
| 集成 | Vitest | 服务层 + 真实 SQLite（每 worker 独立临时 SEL_DATA_DIR）：Slice A/B/C | 23 例 |
| E2E | Playwright | 浏览器走通 J1–J8（mock AI、独立 data-e2e 目录） | 9 例 |

## 关键设计

- **确定性**：mock AI 按文件名 manifest 命中，否则内容哈希派生稳定伪随机；E2E 前 globalSetup 清空数据目录；测试不依赖真实 API。
- **故障注入**：`SEL_MOCK_FAULT=timeout|invalid_json` 演练降级路径，集成测试覆盖"超时→failed→重试→幂等"。
- **PDF 程序化校验**：pdf-lib 校验 A4 尺寸与页数；pdfjs-dist 提取文本层，断言题目页不含提示/答案原文、答案章在最后。
- **隐私断言**：家长聚合 JSON 序列化后断言不含题目原文、提示、答案、反思状态；E2E 断言家长态访问学生页面/接口返回 403。
- **幂等断言**：重复上传同批文件全部 duplicate 且不新增题目；重复处理批次题目数不变；重复生成 PDF 路径稳定且留痕。

## 覆盖映射（验收 → 测试）

- J1 建档/隐私确认 → e2e J1
- J2 采集/进度/低置信/校正 → 集成 sliceA + e2e J2
- J3 四项反思/AI 不代写/家长不可见 → 集成 sliceA（submittedBy 拒绝）+ e2e J3（无预选）
- J4 5–8 可解释/A4/答案分离 → 单元 scoring/scheduling + 集成 sliceB（pdf-lib/pdfjs）+ e2e J4
- J5 回传各结果流转 → 单元 stateMachine + 集成 sliceC + e2e J5
- J6 掌握/确认/复发 → 单元 stateMachine + 集成 sliceC（backdate 模拟延迟）+ e2e J6
- J7 降级与边界（无 Key/超时/重复/旋转/空/不支持/损坏）→ 集成 sliceA + e2e J7
- J8 权限隔离 → 集成 sliceC（聚合内容）+ e2e J8（403）

## 已知未覆盖（有意留白）

- 真实 OpenAI provider 的网络调用（契约已定义，需真实 Key 的冒烟留给试点前）
- 15MB 超大文件的 HTTP 层行为（multer 限制存在；服务层 too_large 有单测覆盖）
- 多浏览器矩阵（目标用户为手机浏览器，E2E 以 390×844 视口单跑 Chromium）
