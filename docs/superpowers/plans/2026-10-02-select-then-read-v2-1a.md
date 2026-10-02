# v2.1a 实施计划：先找题、学生勾、再精读

依据：`docs/superpowers/specs/2026-09-29-student-loop-v2-design.md` D18–D20 与 §9.4 第一步。2026-10-02 用户同意并要求开工。

## 目标

试卷上没有批改痕迹（答题卡 + 网上阅卷）的学校，学生也能把错题放进错题本：拍试卷页 → 在勾选面板里点选或报题号 → 只有被选中的题才精读。有批改痕迹的页面保持现在的全自动。

## 全局约束

- 领域规则不变：AI 只找题、转写、提问；不判断学生答得对不对。
- 真实模式缺配置即失败，绝不退回 mock。
- 未选的题不发任何模型请求。
- 已装在手机上的旧版 App 遇到新状态不能崩（它会显示"状态需核对"，可接受）；新版 App 连旧服务器也要能用。
- 全量门禁：服务器 typecheck、build、Vitest、Playwright；手机 `swift test`、App 编译、界面回归。

## 任务

- [ ] **S1 服务器**（WorkBuddy）：清单后只把有痕迹的题排入精读，其余标为未选；新增"勾选"与"候选题缩略图"接口；桥接认学生勾入的题；周视图与修正报告补计数；接口文档。
- [ ] **S2 手机**（WorkBuddy，与 S1 并行，按本计划的接口约定写）：模型与客户端；题号解析（数字、中文数字、范围）；照片进度里的"勾出错题"入口与勾选面板；界面回归新增一条。
- [ ] **S3 验证与上线**（Claude）：本机真实模型走查（一页有痕迹 + 一页无痕迹的合成试卷）；模拟器走查；部署；装机；更新学生使用指引。

## 接口约定（S1 实现、S2 调用）

- 题目状态新增 `unselected`；题目新增可选字段 `selectedByStudent: true`。
- `POST /v1/recognitions/:id/select`，正文 `{"questionIds":["<uuid>", …]}`（1–30 个、不重复）→ `200 {"job": …}`。未选 → 排队精读并标 `selectedByStudent`；其他状态的 id 忽略（幂等）。`400 invalid_request` 形状不对；`404 not_found` 任务或题目不存在；`409 not_selectable` 还在找题或找题失败；`429 capacity_full` 队列已满。
- `GET /v1/recognitions/:id/questions/:questionId/candidate` → `image/jpeg`，该题候选区域的缩略裁图（任何状态都可取）。
- `GET /v2/week` 的 `photos[]` 每项新增 `unselectedCount`。
- `GET /v2/corrections/report` 每周新增 `manuallySelected`（学生手动勾入并已成为错题的数量）。

## 后续（不在本计划）

成绩单截图自动勾（v2.1b）、补上自己的作答（v2.1c）。
