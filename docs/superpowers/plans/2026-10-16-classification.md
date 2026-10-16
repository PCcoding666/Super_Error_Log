# 错题分类 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为初中错题提供可维护的统一学科/知识点分类，AI 自动归类及历史整理。

**Architecture:** 在学生现有 SQLite 增加独立分类目录、关联和批处理表，旧错题字段保持兼容。稳定 ID 与展示名称分离；目录维护、单题修改、AI 匹配分别负责自己的事务。

**Tech Stack:** Node 24、TypeScript ESM、node:sqlite、Express 5、React 19 SSR、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-16-classification-design.md`

## Global Constraints

- `main` 是唯一主线；每个 PR 独立验证、合并、发版、汇报。
- 不触碰真实学生照片/记录，不改变学生反思和延迟掌握规则，不增加逐题强制确认。
- 不改现有部署保护；PR1 数据库变更需人工发布及迁移验收。
- `SEL_AI_MODE=mock npm run verify` 为每项完成检查；生产与用户验收分别报告。
- 保留每学生独立 worker/SQLite；跨学生目录与题目关联无效。

## Review Focus

- 旧库升级重复执行仍保留完整错题、证据及学习状态（Task 1 迁移集成测试）。
- 改名或已合并条目不得被目录重读/重启初始化复活（Task 1 种子测试；Task 2 维护测试）。
- 知识点和学科、学段、学生归属不一致时拒绝写入（Task 1 约束测试）。
- 数据合法删除级联清理分类与任务，不让清空功能失效（Task 1 删除测试）。
- 后续 AI/历史重试不能覆盖人工确认，陈旧分类结果不能写入（Task 3/5 的并发及重试测试）。

---

### Task 1: PR1 分类基础与初中目录

**Files:**
- Create: `src/db/classificationSchema.ts` — 所有分类表与索引，显式处于部署迁移检查目录。
- Modify: `src/db/schema.ts` — 在旧建表脚本之后执行新增 SQL；不改旧字段。
- Create: `src/classification/types.ts` — 目录和分类状态的类型。
- Create: `src/classification/juniorCatalog.ts` — 稳定标准键、三科初中知识点及别名。
- Create: `src/classification/catalog.ts` — 幂等、事务化初始化与目录读取。
- Create: `tests/integration/classificationSchema.test.ts` — 旧库迁移、归属/来源/状态约束、删除与批次。
- Create: `tests/integration/classificationCatalog.test.ts` — 目录内容、隔离、稳定 ID、重读不覆盖。
- Create: `docs/quality/2026-10-16-classification-pr1.md` — 验证、发布限制及人工验收步骤。

**Interfaces:**
- Consumes: `SCHEMA_SQL`, `getDb(): DatabaseSync`, `newId(prefix: string): string`, `now(): string`。
- Produces: `ensureJuniorCatalog(database: DatabaseSync, studentId: string): void` 与 `readCatalog(database: DatabaseSync, studentId: string, stageId?: string): ClassificationCatalog`；目录字段使用 `id/name/standardKey/topics`，不使用展示名作关联键。
- Produces: `learning_stage`, `classification_catalog`, `classification_subject`, `classification_topic`, `item_classification`, `item_classification_topic`, `classification_batch`, `classification_task`。

- [x] Step 1: 先写迁移/约束/目录集成测试，使用内存 SQLite 和合成学生/错题。
- [x] Step 2: 运行新增测试，确认因分类结构/能力缺失失败。记录到 `/workspace/work/classification/`。
- [x] Step 3: 实现新增 SQL、初中目录和两个目录函数；初始化只发生一次，不改错题、不回写人工目录调整。
- [x] Step 4: 新增测试全绿；运行 `SEL_AI_MODE=mock npm run verify`，检查实际结果。最终类型检查/构建、Vitest 833 通过（5 跳过）、Playwright 37 通过（6 跳过）；部署 Python 14 项通过。
- [ ] Step 5: 单独审查 diff，记录结果；创建 PR 到 `main` 并检查 Actions。
- [ ] Step 6: 生成白名单发布包与 SHA256；在具备人工迁移发布入口后合并、发布和核验。未上线则明确报告阻塞，不能跳过部署保护。

### Task 2: PR2 目录管理与手动归类

依赖 Task 1 的稳定目录/关联。新增独立分类服务与 SSR 视图/路由，以当前 `/s/` 的鉴权、同源表单规则为准；确定具体文件改动前重读最新主线，避免覆盖其间页面更新。

- [ ] 先测试自定义学科、知识点新增/改名/合并、单题选择及跨归属拒绝。
- [ ] 实现目录与单题事务，维护兼容字段，人工修改标记来源和确认状态。
- [ ] 补手机表单旅程，运行完整检查、审查、PR、合并、核实自动发布并汇报。

### Task 3: PR3 新题 AI 分类

依赖目录服务和手动选择契约。AI 使用真实 provider 的现有调用模式；mock 合成测试；不从页面读操作发起分类。

- [ ] 先测试匹配统一 ID、多知识点、待确认、未知 ID、人工优先、内容修订及陈旧结果。
- [ ] 实现单题分类能力及录入接入；保留原始识别证据，不把分类当作证据校验。
- [ ] 完整检查、审查、PR、合并、核实发布并汇报。

### Task 4: PR4 列表筛选

依赖分类关联，复用现有错题列表与周数据，保持原有错题/练习关系。

- [ ] 先测试学科、知识点组合筛选，计数、分页和待确认状态一致。
- [ ] 实现服务查询与 SSR 筛选表单，保证空结果可清除条件。
- [ ] 完整检查、审查、PR、合并、核实发布并汇报。

### Task 5: PR5 历史整理

依赖 Task 3 的单题分类能力，使用 Task 1 的持久化批次/任务。

- [ ] 先测试分批、重复请求、失败重试、进程恢复、人工保护和用户隔离。
- [ ] 实现任务认领与有界处理、状态查询和进度/重试 UI；不在迁移中执行 AI 或无界处理历史题。
- [ ] 完整检查、审查、PR、合并、核实发布并汇报。

后续任务在开始时补齐具体接口与测试步骤；当前可执行范围是 Task 1。不得将本文件后续概述当作已审查的代码级任务。
