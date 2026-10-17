# Student practice implementation plan

> **For agentic workers:** Use superpowers:executing-plans. Track completed tasks below.

**Goal:** Deliver the approved three-entry, optional-photo practice flow.
**Architecture:** Retain SSR forms and existing invitation isolation. Reuse frozen print snapshots as clean practice content and existing review_attempt records for results. Persist cursor/hint exposure and attachments separately from mastery.
**Tech Stack:** TypeScript, Express, React SSR, SQLite, Vitest, Playwright.
**Spec:** docs/superpowers/specs/2026-10-17-student-practice-design.md

## Global constraints
- No hydration or additional dependencies; all learning records remain server-owned.
- Preserve photo normalization/retry/idempotency, classification navigation, evidence warnings and mastery rules.
- No actual print required for completion; no photo required for completion; no automatic grading.
- Start from current origin/main (6fb8971), use short-lived branches. Four cumulative PRs target main; review incremental comparisons in order (#30, #31, #32, #33), then merge only #33 using a merge commit so the complete flow reaches main together.

## Review focus
- Partial progress and skipped questions survive navigation and restart.
- Forged item/packet combinations, duplicate posts and competing uploads cannot alter another record.
- Snapshot preparation and upload/recognition failures allow recovery without losing results.
- Hint exposure must not be recorded as independent work.
- Printing a completed practice must not reset results or reveal unselected answers.

### Task 1: Three-entry navigation
Files: src/web/views/{layout,photos,practice,items}.tsx, src/web/router.ts, tests/integration/webClient.test.ts.
- [x] Update root navigation and upload/library actions; remove schedule prompts from active screens.
- [x] Verify root opens library and all three entries are reachable; preserve consent and category navigation.
- [x] Commit feat(web): introduce three student workspaces.

### Task 2: Practice and self-check
Files: src/v2/practiceProgress.ts, src/web/practiceRouter.ts, src/web/views/onlinePractice.tsx, src/web/router.ts, src/db/schema.ts, tests/integration/webClient.test.ts.
Interfaces: practice progress reads packet membership, review_attempt and v2_print_snapshot; router mounted under authenticated /s, using existing coach provider.
- [x] Test resume/skip, hidden answers, immediate partial results, duplicate submit and foreign membership.
- [x] Add persistent cursor/hint tracking and online question/check/results screens; creation prepares the frozen content without requiring printing.
- [x] Use existing submitReturns for date validation and mastery; validate focused integration tests and typecheck.
- [x] Commit feat(practice): support resumable online self-check.

### Task 3: Optional handwriting
Files: src/v2/practiceWork.ts, src/ai/handwriting.ts, src/web/practiceRouter.ts, src/web/views/onlinePractice.tsx, src/web/photoUpload.ts, src/db/schema.ts; integration/unit tests.
Interfaces: injectable HandwritingRecognizer; attachment identity includes packet/item and request key; images never enter mobile_item_link.
- [x] Test duplicate upload, failed recognition, membership validation and valid extraction.
- [x] Reuse normalized photo upload with preview and a dedicated attachment endpoint; retain photo on recognition failure.
- [x] Verify attachment access and optional self-check, then commit feat(practice): attach optional handwritten work.

### Task 4: Printing
Files: src/web/views/practice.tsx, src/web/router.ts, src/web/views/onlinePractice.tsx; print/integration tests.
- [x] Test optional answer section and unchanged progress after printing.
- [x] Add prominent print and paper-result links, default questions-only print, optional answer appendix.
- [x] Run SEL_AI_MODE=mock npm run verify; review entire change; commit feat(practice): integrate optional printing and paper results.

## Integration and release

- Final integration PR: #33, including the commits from #30–32 and fixes for the three automatic review findings (shared upload admission/image semaphore, local-date minimum, and replacement-photo navigation).
- Run `npm run verify` and require green CI on the final PR head before merging. A merge commit preserves the earlier branch ancestry; confirm #30–32 are marked merged afterward.
- This release adds `practice_progress`, `practice_question_progress`, and `practice_work` with `CREATE TABLE IF NOT EXISTS`; it does not alter or delete existing learning records.
- The existing production guard in `deploy/ci/sel-ci-deploy.py::check_migrations` rejects changes under `dist/db`. Therefore this merge requires a separately planned manual production release; green CI and a merged PR do not establish deployment success. Keep the guard in place and confirm the actual production Action result.
- Manual release must use the existing administrator deployment procedure: verify a consistent backup, start the new version so the additive schema is applied, check login/assets/anonymous API refusal, then verify the student flow with an authorized test account. Code rollback must preserve the database and any newly written records.
