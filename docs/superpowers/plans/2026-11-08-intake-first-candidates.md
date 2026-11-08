# Intake first selectable candidates — implementation plan

> **For agentic workers:** Use superpowers:executing-plans for implementation; independent regression and whole-branch review follow AGENTS.md.

**Goal:** Show selectable local question crops immediately after locate, while read/verify continues.
**Architecture:** Keep a source-bound preview in existing material_job.input_json. Provider callbacks publish locate/read/verify snapshots; preview fragments never become learning evidence. Existing final extraction/reconciliation remains authoritative. Stable fragment-based candidate IDs retain picks across enrichment and retries. Submitted picks persist until trustworthy reconciled stems can be included.
**Tech Stack:** TypeScript, SQLite JSON, Express /s/api, Ionic React, Vitest, Playwright.
**Spec:** https://github.com/PCcoding666/Super_Error_Log/issues/121 (user requested implementation in chat).

## Global constraints

- No schema/registry, production/env or concurrency changes; AI=4 remains unchanged.
- Existing client and /s/api only; no new mandatory student verification step.
- Policy A: accept selection early, write learning records after verified stem/diagram. Existing low-confidence manual paths remain available for older results.
- Preview is explicitly preliminary/verifying/verified/needs review; no invented answer or grade.
- ~30s is a measured P50 target on typical single real pages, not a hard guarantee or full extraction deadline.

## Review focus

- Source changes, terminal jobs and cross-student/photo IDs must not serve or accept stale preview evidence.
- Retry/restart must retain preview identity, saved selections and successful model checkpoints.
- Verified teacher marks with an untrusted/incomplete stem must not automatically create an item.
- Polling and final reconciliation must preserve local selections without double filing.
- Failed enrichment must leave useful crops and honest status; read-only endpoints must remain read-only.

### Task 1: Source-bound progressive extraction

Files: src/materials/provider.ts, extraction.ts, new intakeProgress.ts; tests/integration/materialExtraction.test.ts.
Interface: optional extract input onProgress({extraction, phase:'located'|'enriching'}). Persist each page snapshot under job input intakeProgress, preserve selected fragment IDs and timings. Validate against current source and active job. Final reconciliation flushes trusted selections, never merges preview into material_fragment.
- [x] Add a slow HTTP model test proving first preview exists before read returns and carries no learning rows; run RED.
- [x] Publish locate and read/verify snapshots; save safely; run focused GREEN.
- [x] Cover retry, source replacement, failed sibling, missing diagram and untrusted automatic filing.

### Task 2: API and selection policy

Files: src/web/api.ts, apiTypes.ts, intakeCandidateDetail.ts, src/materials/intakeProgress.ts; independent integration regression.
Interface: stable `mfr_ID:sourceRevision` preview IDs, candidate status and submitted flag; photo progress (stage, total, verified, timing). Existing candidate detail endpoint also accepts preview identity; local crop endpoint is source-bound. Select accepts both legacy material question IDs and preview IDs, enforcing photo ownership. Return included/pending/skipped.
- [x] Add endpoint tests for candidates while running, read-only detail/crop and durable deferred selection; run RED.
- [x] Project preview candidates, preserve busy polling, suppress duplicate final candidates; run GREEN.
- [x] Verify pending selection survives reload/retry and final item appears once.

### Task 3: Client, evidence and delivery

Files: client/src/pages/IntakePage.tsx, components/CandidateDetailModal.tsx, lib/api.ts; new Playwright regression and quality report.
- [x] Browser test first batch selection and stem update while job remains running; preserve same checkbox and submitted status after reload.
- [x] Add preliminary/verifying labels, neutral instruction (marks not known yet), busy spinner and explicit pending-save feedback.
- [ ] Run SEL_AI_MODE=mock npm run verify; record actual results and separate real-latency evidence from synthetic timing.
- [ ] Independent whole-branch review, fixes, commit, push task branch, PR against main; no merge or deployment.
