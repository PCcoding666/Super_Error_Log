# Admin Usage Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 独立管理后台查看邀请码账号的使用、tokens 与调用性能。
**Architecture:** 每学生独立采集 SQLite，管理进程读取白名单元数据并合并历史视觉日志。独立管理认证、SSR 页面与现有生产装配接入。
**Tech Stack:** Node >=24, TypeScript, Express 5, React 19 SSR, node:sqlite, Vitest, Playwright.
**Spec:** `docs/superpowers/specs/2026-10-20-admin-usage-design.md`

## Global Constraints

- Node >=24，无新增运行时依赖；无 hydration。
- 保留学生进程/数据库隔离，不向后台暴露题目正文、反思、图片、密钥、邀请码明文或哈希。
- 未知 tokens/耗时为 null；历史覆盖不完整有明确提示；日期按 Asia/Singapore。
- 本轮只交付 PR、运行本机合成测试；后续合入 main 后沿用仓库已授权的 CI/CD。

## Review Focus

- 失败/取消有已报告 usage 时仍入账，且不因记录失败改变原始业务结果（任务 1）。
- 旧日志、重复读取、多个邀请码不得重复计费，损坏数据不能变成零用量（任务 2）。
- 管理员密码轮换、学生 cookie、跨站 POST 和过期会话不能获得管理访问（任务 3）。
- 学生未初始化业务库、文件损坏、日期跨午夜与空筛选时可解释显示（任务 2/4）。
- 生产主进程正确挂载，worker 不挂载；手机表格可横向滚动，分页保留筛选（任务 4）。

### Task 1: AI attempt telemetry
**Files:** Create `src/observability/aiUsage.ts`; modify `src/ai/chatClient.ts`, `src/ai/asr.ts`, `src/mobile/vision.ts`; test `tests/integration/aiUsage.test.ts`.
**Interfaces:** Produces `AiUsageRecord`, `recordAiUsage`, `readAiUsage` with sanitized metadata and nullable tokens/duration. Chat traces expose stable usage ID for historical-log deduplication.
- [x] Write tests using temporary dirs and synthetic providers for success, invalid JSON, missing usage, HTTP failure, timeout/cancel and restart persistence; run and observe expected missing telemetry failure.
- [x] Implement the per-student store and instrument actual HTTP attempts; preserve cancellation and provider errors, isolate observer storage errors.
- [x] Run `SEL_AI_MODE=mock npx vitest run tests/integration/aiUsage.test.ts tests/unit/asr.test.ts tests/integration/stagedProvider.test.ts` → pass; commit task.

### Task 2: Safe account aggregation
**Files:** Create `src/admin/report.ts`; modify `src/studentHost/registry.ts`; test `tests/integration/adminReport.test.ts`.
**Interfaces:** Consumes `AiUsageRecord`; produces `readAdminReport(registry, filters)` and validated `parseAdminFilters(query)`. Registry exposes invitation public IDs/status and last activity.
- [x] Write tests for two accounts, replacement invitations, known/unknown tokens, SQL/filter/date bounds, legacy deduplication, corrupt/missing stores, and paging; observe failure.
- [x] Implement metadata-only reporting, lifetime business counts, coverage messages and full-filter aggregates.
- [x] Run `SEL_AI_MODE=mock npx vitest run tests/integration/adminReport.test.ts tests/integration/studentHost.test.ts` → pass; commit task.

### Task 3: Independent admin authentication
**Files:** Create `src/admin/auth.ts`, `src/admin/router.ts`, `src/admin/views.tsx`; extend `src/studentHost/admin-cli.ts`; test `tests/integration/adminDashboard.test.ts`.
**Interfaces:** Admin auth manages generated password, session verification and logout. Router consumes registry/report; only authenticated GET returns metrics.
- [x] Write HTTP tests for login, no credentials, student/forged cookie, CSRF, throttling, logout, rotation/expiry and no sensitive metadata in HTML; observe failure.
- [x] Implement auth, CLI bootstrap, login/report pages and responsive CSS.
- [x] Run `SEL_AI_MODE=mock npx vitest run tests/integration/adminDashboard.test.ts` → pass; commit task.

### Task 4: Production assembly and browser verification
**Files:** Modify `src/mobile/router.ts`, `src/mobile/cloudAssembly.ts`; create browser fixture/spec, update deployment and handoff docs.
**Interfaces:** Mount admin router only alongside student host; use existing trusted client-IP derivation and fixed HTTPS origin scheme.
- [x] Add assembly/browser regression test for real login, filters, accounts, pagination and mobile layout; observe failure before assembly changes.
- [x] Wire production lifecycle and document bootstrap command, metric definitions and historic limitations.
- [x] Run `SEL_AI_MODE=mock npm run verify` → typecheck/build/Vitest/Playwright pass. Review whole change, address material findings, record evidence and commit.
