# Proactive Paper Practice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace practice-file management with a proactive paper task, batch photo submission, and reviewable feedback.

**Architecture:** Keep existing practice selection, frozen print snapshots and mastery transitions. Add task lifecycle and task-scoped photo/review tables, a bounded analysis provider and dedicated SSR routes/views. Existing per-question self-check remains the fallback.

**Tech Stack:** Node 24, TypeScript ESM, Express 5, React 19 SSR, SQLite, sharp, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-20-proactive-paper-practice-design.md`

## Global Constraints

- Node >= 24；TypeScript ESM、React SSR，无 hydration。
- 默认最多 3 题，可通过现有选题页选择 1–8 题。
- 每任务最多 12 张照片，每张上传最多 15 MiB。
- 每版本最多 3 次分析。
- AI 建议本身不产生掌握；保留提示下限、至少 3 天延迟等规则。
- 主交付为 `/s/` 手机网页；iPad 白板、变式生成、外部题库本轮不做。
- 用户授权开发、验证后直接合并；直接执行，无需再次确认。

## Review Focus

1. A paused/cancelled older task must not occupy the primary slot or incorrectly change completed learning records.
2. A saved photo whose HTTP response was lost must survive retry without duplication or conflicting ownership.
3. A second photo arriving during analysis must invalidate the old response, including after process interruption.
4. An ambiguous or incomplete multi-page answer must remain unresolved, never silently become correct or independent.
5. Partial confirmation, date errors and stale forms must preserve other results and never create duplicate mastery events.

---

### Task 1: Lifecycle and proactive dashboard

**Files:** Create `src/v2/practiceTasks.ts`, `src/web/views/practiceDashboard.tsx`, `tests/integration/practiceTasks.test.ts`; modify `src/db/schema.ts`, `src/v2/practiceService.ts`, `src/web/router.ts`.

**Interfaces:**
- Consumes `recommendPractice(dir): RecommendResponse`, `createPractice(input): CreatePracticeResult`, `practiceProgress(id)`.
- Produces `taskLifecycle(id): 'active'|'paused'|'cancelled'`, `setTaskLifecycle(id, state): void`, `startSuggestedPractice(dir, key): CreatePracticeResult`.
- Dashboard uses existing `PracticeDetail` and recommendations; no model call on GET.

- [ ] Add tests asserting GET does not create, start retries return the same packet, recommendation contains <=3 items, paused tasks resume and cancellation releases only unanswered items.
- [ ] Run `SEL_AI_MODE=mock npx vitest run tests/integration/practiceTasks.test.ts`; expect failures for missing behavior.
- [ ] Add lifecycle/request-key tables and cancellation-aware candidate eligibility; implement state-aware dashboard and POST actions.
- [ ] Run task tests and affected `v2Practice`/web integration tests; expect PASS.
- [ ] Commit `feat(practice): prioritize actionable paper tasks`.

### Task 2: Paper reading and clear progress

**Files:** Modify `src/web/views/onlinePractice.tsx`, `src/web/views/practice.tsx`, `src/web/practiceRouter.ts`, `src/web/assets.ts`; tests in `tests/integration/webClient.test.ts`.

**Interfaces:**
- Consumes task lifecycle and frozen `PrintSnapshot`.
- Produces paper-first question view, explicit result progress, optional print/reflection, stable links to `/s/practice/:pid/submit` and `/feedback`.

- [ ] Add regression tests for hidden answers, optional printing, cancelled-task write rejection, explicit progress and photo-submit links.
- [ ] Run targeted tests; expect changed UI assertions to fail.
- [ ] Update page actions/copy, retain legacy query routes and self-check, prevent cancelled task writes.
- [ ] Run affected tests, preserving hint and delayed mastery assertions; expect PASS.
- [ ] Commit `feat(practice): make paper work the default journey`.

### Task 3: Durable batch photos and analysis

**Files:** Create `src/ai/practiceReview.ts`, `src/v2/practiceSubmission.ts`, `src/db/practiceSubmissionSchema.ts`, `tests/integration/practiceSubmission.test.ts`, `tests/unit/practiceReview.test.ts`; modify `src/db/schema.ts`.

**Interfaces:**
- `PracticeReviewer.review({questions, photos}): Promise<PracticeReview>`; questions contain exact task numbers and frozen stems/reference answers, photos contain normalized image bytes.
- `attachSubmission(packetId,key,bytes): Promise<SubmissionPhoto>`.
- `submissionState(packetId): SubmissionState` returns durable photos, revision, review status and findings.
- `reviewSubmission(packetId, reviewer): Promise<void>` coalesces concurrent calls and ignores stale versions.
- `assignSubmissionFinding(packetId, revision, findingIndex, itemId): void` validates membership and marks ambiguous grading unresolved.

- [ ] Add tests for 12-photo/15MiB limits, normalization, retries, conflicting keys, no new error items, cross-task lookup, multi-page analysis, failure retention, stale revisions and retry limits.
- [ ] Add validator tests for unknown/duplicate question numbers, invalid shapes, missing evidence and uncertain grading.
- [ ] Run new tests; expect failures for absent interfaces.
- [ ] Implement additive schema, storage and versioned bounded analysis; mock mode gives explicit synthetic uncertain output, real mode uses `ChatClient`.
- [ ] Run new tests; expect PASS.
- [ ] Commit `feat(practice): preserve batch work and review suggestions`.

### Task 4: Upload and feedback flow

**Files:** Create `src/web/submissionRouter.ts`, `src/web/views/practiceSubmission.tsx`; modify `src/web/router.ts`, `src/web/practiceRouter.ts`, `src/web/photoUpload.ts`, `src/v2/practiceSubmission.ts`; tests in `tests/integration/webClient.test.ts`.

**Interfaces:**
- Authenticated routes `/practice/:pid/submit`, `/submissions`, `/review`, `/feedback`, `/feedback/assign`, `/feedback/confirm` and task-scoped photo retrieval.
- `confirmSubmission(packetId, revision, input)` records only explicit student-confirmed entries through `submitReturns`.
- Optional `practiceReviewer` injectable in `WebClientOptions`; production defaults to configured provider.

- [ ] Write HTTP tests for consent, same-origin guards, upload admission, JSON and no-JS paths, partial failure, persistent photos after model failure, explicit dates/help, uncertain entries and repeat confirmation.
- [ ] Run targeted tests; expect 404/missing-flow failures.
- [ ] Implement photo queue and batch analysis POST, pending/failed/ready views, only ambiguous association controls, editable suggestions and partial confirmation.
- [ ] Preserve existing JPEG/retry behavior; change single-photo slicing only for the new batch form.
- [ ] Run submission, upload and web integration tests; expect PASS.
- [ ] Commit `feat(practice): submit paper work and confirm useful feedback`.

### Task 5: Browser acceptance and integration

**Files:** Create `tests/e2e/proactivePractice.spec.ts`, `docs/quality/2026-10-20-proactive-paper-practice.md`; update affected existing browser tests and fixture server.

**Interfaces:** Consumes completed task and submission routes; exercises synthetic providers through real SSR browser paths.

- [ ] Add a journey covering recommended task acceptance, white-paper instructions, multiple photos, review/partial confirmation, resume, hints and cancellation.
- [ ] Exercise mobile light/dark, 320px and iPad layout, no-JS upload, batch failure/retry and task-scoped photo ownership.
- [ ] Run `SEL_AI_MODE=mock npm run verify`; expect all required gates PASS.
- [ ] Record screenshots and actual verification limits in quality notes; commit.
- [ ] Run independent whole-branch review, fix important findings with failing regressions, then rerun relevant/full checks.
- [ ] Push branch, create PR against `main`, wait for required checks, merge exact reviewed head, inspect resulting CI/deployment.
