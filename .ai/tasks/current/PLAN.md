# PLAN — 阶段计划

## Phase 0 — Reset & Evidence ✅（进行中→完成标准见 ACCEPTANCE）
1. ✅ 验证项目根目录真实路径
2. ✅ 旧仓库盘点（132 文件）、敏感路径记录
3. ✅ 创建 `.ai/tasks/current/` 状态文件
4. ✅ 隔离 secret/用户数据至 `.ai/legacy/preserved/`
5. ✅ 删除旧实现
6. 环境审计 ✅（Node 26.4 / npm 11.17 / pnpm / Playwright 1.62.1 + Chromium 1228 已缓存）

## Phase 1 — Product Model
- docs/product/PRD.md、PRODUCT_SPEC.md、PILOT_PROTOCOL.md、ASSUMPTION_REGISTER.md
- 门：与已确认事实一致；MVP/非目标明确；无 AI 代反思；无工作日屏幕依赖

## Phase 2 — Architecture & Skeleton
- docs/architecture/{ARCHITECTURE,DATA_MODEL,AI_PROVIDER_CONTRACT}.md
- 技术栈决策（倾向：TypeScript + Next.js 或 Express + better-sqlite3 + Playwright；先验证依赖可安装）
- 应用骨架、DB 初始化、seed（20 道合成错题 fixture）、健康检查
- 门：本地可启动；无 Key mock 可运行

## Phase 3 — Vertical Slice A：Capture → Reflection
- 批量上传（图片/PDF）、批次状态、mock 提取、低置信度校正、错题条目、四项最小反思
- 门：20 道合成错题全流程；重复上传幂等；错误可恢复 UI

## Phase 4 — Vertical Slice B：Selection → Print
- 可解释复习评分、5–8 题计划、A4 黑白 PDF（题目/答案分离、演算空间、短 ID、结果勾选框）
- 门：PDF 可下载、程序+视觉检查通过

## Phase 5 — Vertical Slice C：Attempt → Mastery
- 结果回传（上传完成页匹配 + 快速录入）、状态机流转、再复习调度、趋势视图、权限隔离
- 门：失败题进下次包；延迟独立成功→暂时掌握；家长不可见私人反思（自动化测试）

## Phase 6 — Product Closure
- 完整 E2E（J1–J8）、视觉走查、PDF 检查、无障碍检查
- docs/product/{MVP_USER_MANUAL,PRODUCT_VALIDATION_REPORT}.md、README、HANDOFF、PR_DESCRIPTION
- docs/quality/{TEST_STRATEGY,RELEASE_CHECKLIST}.md、docs/privacy/PRIVACY_AND_MINOR_DATA.md
- 独立反证审查（INDEPENDENT_REVIEW）
- 门：按手册可从零完成 demo；全量质量命令通过
