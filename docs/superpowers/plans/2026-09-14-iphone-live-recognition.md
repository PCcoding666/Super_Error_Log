# iPhone Live Recognition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chinese student UI receives real Beijing Bailian recognition, retains uncertainty and source evidence, and supports reflection and clean paper practice.

**Architecture:** An isolated loopback Express service persists image jobs and per-question stage results. SwiftUI uses an authenticated URLSession adapter, versioned local snapshots and the existing reflection journey. Recognition candidates are not automatically accepted or classified as wrong.

**Tech Stack:** TypeScript, Express 5, existing Sharp/image and multimodal evidence modules, Node filesystem persistence; SwiftUI, Foundation, Security Keychain, UIKit/PDFKit, Vitest and XCTest.

**Spec:** `docs/superpowers/specs/2026-09-14-iphone-live-recognition-design.md`

## Global Constraints

- 应用主交互统一使用简体中文；原题、原始作答和订正保留原语言。
- 本轮使用 Mac 本地服务和 iPhone 模拟器。默认仅监听 `127.0.0.1:3101`。
- 不在手机放百炼密钥。使用独立本地配对令牌；客户端存入 Keychain。
- 真实识别服务拒绝 Mock 配置。失败不能降级为演示数据。
- 使用独立本地目录 `data/mobile-recognition/`，测试与十图验收另建唯一目录。
- 不重置数据库、不改全局 Xcode、不部署。2026-09-15 用户已授权结束后推送 GitHub：只由主 Session 在完成实现、验证和最终审查后提交相关代码并推送到经核实的现有开发分支；不提前推送、强推、合并或创建 PR，不包含无关修改、密钥或私有照片。
- 沿用当前工作目录的隔离约定，不创建或声称存在新 Git worktree。
- 照片、原始模型输出和错误记录保留；成功请求、候选、自动检查、人工确认与打印资格分别记录。
- Use apply_patch for source/document edits. No subagents from implementers/reviewers. Never print credentials or include them in subprocess arguments.
- Node/Swift tests use isolated temporary collections. Existing baseline: 204 backend tests and 11 Swift domain tests passed on this task before implementation; refresh relevant checks after changes.

## Task 1: Durable mobile recognition service and real vision adapter

**Files:**
- Create `src/mobile/contracts.ts`, `store.ts`, `service.ts`, `vision.ts`, `router.ts`, `server.ts`, `configuration.ts`.
- Create `tests/unit/mobileStore.test.ts`, `tests/integration/mobileRecognition.test.ts`, `tests/integration/mobileVision.test.ts`.
- Modify shared `src/ai/chatClient.ts` only for optional bounded secure trace/error classification needed by the adapter; preserve web defaults.
- Modify `package.json` only for `mobile:dev` / `mobile:start` entrypoints, and add `docs/mobile-recognition-api.md` with complete request/response examples.

**Interfaces:**
- Exports `createMobileApp(options)` for integration tests and `MobileRecognitionService` for route composition. `options` must inject data directory, pairing token and real-vision boundary for tests; no test-only reset APIs.
- HTTP consumes Bearer pairing token, `POST /v1/recognitions` raw `image/jpeg` bytes, `Idempotency-Key` UUID, optional percent-encoded `X-Photo-Name`.
- Responses for submit/get/retry/confirm are `{job: RecognitionJob}`; list is `{jobs: RecognitionJob[]}`; errors `{error:{code:string,message:string}}`.
- `RecognitionJob`: `version:1`, UUID `id`, integer `revision`, `photoName`, `sourceHash`, `sourceMediaId`, `status` (`queued|processing|completed|partial|failed|interrupted`), `phase` (`inventory|questions|complete`), `inventoryWarnings:string[]`, `questions:RecognitionQuestion[]`, nullable `error`, ISO `createdAt`/`updatedAt`.
- `RecognitionQuestion`: UUID `id`, `number`, integer `revision`, `status` (`queued|processing|needs_check|ready|failed|confirmed|skipped`), `selectionEvidence` (`marked_wrong|corrected|unmarked|unclear`), nullable existing `Evidence` in `evidence`, nullable `verification`, nullable `questionMediaId`, `diagramMediaIds:string[]`, nullable `error`, nullable ISO `confirmedAt`. `verification` contains booleans `textComplete`, `questionCropComplete`, `questionCropPure`, `transcriptionMatches`, `diagramSafe`, plus `issues:string[]`. No boolean is inferred from missing data.
- Failures carry `code`, student-safe Chinese `message`, `stage`, `retryable`.
- `GET /v1/recognitions` lists this local paired collection for recovery on the simulator; no webpage DB or student cookies.
- `POST /v1/recognitions/:id/retry`: `{questionId:string|null}`; null retries failed/interrupted inventory only. Successful stages never silently rerun.
- `POST /v1/recognitions/:id/questions/:questionId/confirm`: `{revision:number,action:"confirm"|"skip"}`. Confirm requires all checks true, no uncertainties, source-compared user acknowledgement; accept `sourceCompared:true` in request. Skip does not accept evidence. Stale requests return 409.
- Media routes use allocated IDs and known files only; never accept arbitrary paths/remote URLs. Response headers private/no-store.

**Required behavior:**
- Atomic durable jobs, source bytes and transformed image hash, request dedup including concurrent requests, conflicting idempotency payload 409, stable question IDs, safe permissions, no auto-paid resume after restart. Completed result stays available if another question fails.
- Process jobs asynchronously with bounded concurrency (one photo job, at most two simultaneous model calls). Persist queued entries before returning 202. Restart marks pending work interrupted; explicit retry continues unfinished work without dropping inventory/candidates.
- Inventory reads whole page, allows duplicate printed numbers at different positions, includes partial-edge candidates/warnings, has a finite max 30 candidates with explicit capacity warning. No fixed target hints or prepared answers in prompts.
- Each question transcribes against the full original and validates `Evidence`. Preserve raw response and usage even when schema rejects. Returned coordinates require actual crop checking independently; implement bounded corrective grounding (at most two additional passes) using verification issues, preserving prior versions.
- Verification reads full page and actual question/diagram crops, checks printed stem completeness, no leaked answer, matching transcription and necessary diagram purity. Reuse existing crop tools and evidence validation where compatible; do not conflate source reading with coordinates. A failed check yields needs_check, not success. Returned diagrams are not clean merely because the model labels them as diagrams.
- Student vs correction remains separate, no correction author required. AI observations may quote evidence but no fabricated psychological diagnosis/reference solution. Optional diagnosis is not a prerequisite to viewing a candidate.
- Keep full per-call request metadata/prompts and response bodies in restricted attempt files; exclude authorization headers and image base64 from logs (source hash references suffice). Mobile responses never expose raw sensitive dumps.
- Real provider cfg reads existing root env without logging secrets; requires Beijing official endpoint, nonempty key/model and non-mock mode. Mobile timeout default 1,800,000 ms, dedicated override, not web config mutation. Maximum three attempts only for network/429/transient 5xx; auth/permissions/unsupported stop, schema errors explicit. Test output bound and redaction.
- Store on Mac excluded from backup where available? Native exclusion is mandatory; server directory permissions 0700/files0600 and ignored data are the contract. Do not promise remote provider retention policies.

- [ ] RED: write persistence/route tests first, run focused Vitest and record expected missing-feature failure. Example expectations:
```ts
expect((await requestWithoutToken()).status).toBe(401);
expect(first.body.job.id).toBe(repeated.body.job.id);
expect(conflicting.status).toBe(409);
expect(reloaded.questions[0].evidence.questionText).toBe('求 x 的值。');
expect(reloaded.questions[1].status).toBe('failed');
expect((await confirmWithoutPassingChecks()).status).toBe(409);
```
- [ ] GREEN: implement repository/worker and authenticated routes, test real disk and real HTTP. External vision fixtures may be synthetic but must retain all tested boundary fields. Include race between concurrent duplicate submits and process restart without resubmission charges.
- [ ] RED/GREEN: add real vision adapter against a local synthetic HTTP model server. Verify image inputs contain actual source/crop bytes, duplicate numbers stay separate, truncated/invalid responses retained, partial/uncertain content cannot confirm, failed retry preserves good results.
- [ ] Run `npm run typecheck`, focused mobile tests, then full `npm test` once. No Playwright/seed/reset commands.
- [ ] Write API documentation and full report with exact tests, paths and red/green evidence. Freeze contract before Task 2. No actual paid model calls by this worker; root owns the live run.

## Task 2: Chinese SwiftUI client, persistence migration and clean PDF

**Files:**
- Create `iOS/StudentApp/Domain/Recognition.swift`, `StudyProblem.swift`; `RecognitionClient.swift`, `PairingStore.swift`, `RecognitionView.swift`.
- Modify `Domain/StudyState.swift`, `Domain/SampleProblem.swift`, `StudyStore.swift`, `ThisWeekView.swift`, `ReflectionView.swift`, `ReviewPackView.swift`, `ReviewPDF.swift`, `SourcePhotoView.swift`, `SuperErrorLogApp.swift`, `Theme.swift` and Info.plist build settings where required.
- Modify `iOS/Tests/StudyStateTests.swift`; create `iOS/Tests/RecognitionTests.swift`; update `iOS/UITests/StudentJourneyTests.swift`, add `LiveRecognitionJourneyTests.swift`.
- Update `iOS/README.md` only to actual current feature state. Simulator launch helper changes must preserve global Xcode selection and private data.

**Interfaces:**
- Decode contract in `docs/mobile-recognition-api.md` from Task 1. URLSession short polling requests, raw JPEG uploads using persisted UUID idempotency key; dynamic job state never interpreted as static sample data.
- Pairing settings contain only loopback base URL and local pairing token in Keychain. No Bailian key and no baked-in pairing token. Never include auth in URLs or diagnostics. Show Chinese connection/settings UI.
- `StudyProblem` snapshot unifies examples and confirmed real questions. Stable IDs, source image path, printed stem, safe diagram references, source observations, confirmation revision, printable gate. `PaperPack` retains immutable problem snapshots and safely decodes old packs.
- Store API may evolve but must preserve current reflection semantics (explicit submit, no auto selection, atomic disk-before-UI commit).

**Required behavior:**
- Chinese main UI and app-owned PDF labels; raw old English choice values remain stable internal IDs mapped to Chinese, old free text unmodified. Original Chinese maths is not rewritten by translation.
- Use these display mappings for the existing choice values (stored values unchanged): `I had a plan` → `当时有思路`; `I got stuck partway` → `做到一半卡住了`; `I was unsure` → `一开始就没把握`; `Check each calculation` → `检查每一步计算`; `Choose a different method` → `换一种方法`; `Read the question more carefully` → `先读清题目条件`; `I’m not sure yet` → `还没想清楚`; `On my own` → `能独立完成`; `With a hint` → `需要一点提示`; `I need to learn it again` → `还要再学一下`; `I solved it independently` → `这次独立做出来了`; `I needed a hint` → `看了提示才做出来`; `I’m still working on it` → `还没有做出来`.
- Add photos saves locally. User sees selected local photos and explicit provider-upload consent before each submission batch; declining issues zero requests. Native authorization explanation Chinese. Disable duplicate taps without losing durable upload retry state.
- Display actual photo and question progress; open candidates, filter all vs marked/corrected; always open local full original with zoom. Lists should not claim candidates are confirmed mistakes.
- Show source-linked transcription and corrections, actual safe diagrams. Current unresolved issue one at a time, keep unclear/skip; no empty generic technical inspector. Ready result can be source-compared and confirmed. Needs_check cannot be bypassed with blanket acceptance. Retry failed question/inventory preserves others.
- Persist tasks and accepted question snapshots, resume polling on activation, stop polling when backgrounded without cancelling server job; offline results usable. Avoid blocking main actor on uploads/image IO. Persist upload key before POST so a lost response recovers idempotently.
- Reflect uses actual confirmed snapshots, Examples separate and excluded from real progress counts. Existing saved example work remains available.
- PDF uses selected completed accepted snapshots only, handles long printed stems across pages, embeds required verified clean diagrams, never renders original answers/corrections or source page. Guard missing file before generating; no silently empty diagrams. PDF view should disclose exact content, not give false clean claims for blocked inputs.
- The app client accepts only `http://127.0.0.1:<port>` or localhost/IPv6 loopback with no credentials/query/fragment. Redirects must not forward pairing credentials elsewhere. No global insecure ATS exception; simulator loopback only.
- Test ISO timestamps including JavaScript fractional seconds; reject stale job snapshots instead of overwriting newer confirmed results. Simulator setup must not embed the real pairing token in arguments or test logs. If a Debug-only pairing-file bootstrap is needed, consume a scoped file from the app collection into Keychain with clear error handling, no token logging and no bundle secret; document QA setup distinctly from normal Settings entry.

- [ ] RED: Swift domain tests for migration, real question vs unknown/unchecked rejection, immutable pack, stable old choices and idempotent ingestion. Example:
```swift
XCTAssertEqual(loaded.drafts["5516-14"]?.note, "My original note")
XCTAssertThrowsError(try unconfirmedState.select(realID, selected: true))
XCTAssertEqual(oldPack.problemSnapshots.first?.stem, "求 x 的值。")
```
- [ ] GREEN: implement domains/migration, run `env DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test` from iOS. Add API client tests at HTTP boundary or injected URLProtocol without bypassing decoding/validation.
- [ ] RED/GREEN: UI tests cover Chinese navigation/import consent, confirmation, real-shaped job display (label synthetic tests explicitly), relaunch/offline, reflection and PDF. Keep stable accessibility identifiers while updating display text to Chinese.
- [ ] Build via `xcodebuild -project SuperErrorLog.xcodeproj -target StudentAppUITests -configuration Debug -sdk iphonesimulator SYMROOT=build/Manual build CODE_SIGNING_ALLOWED=NO -quiet` with process-local DEVELOPER_DIR. Do not edit files while build reads them.
- [ ] Run domain tests and available simulator UI tests with fresh result bundles, append report with exact results. Root owns live AI acceptance, image adjudication and final captures. No commits.

## Task 3: Ten-photo live acceptance and handoff

**Files:**
- Create `src/cli/mobilePilot.ts`, `tests/unit/mobilePilot.test.ts` if needed for reproducible authenticated API submissions; no hardcoded source answers.
- Create unique ignored `data/mobile-pilot-20260914-<unique>/` with requests/jobs/attempt evidence, acceptance notes, PDF and screenshots.
- Update `iOS/VERIFICATION.md`, `iOS/README.md`, and this plan's checkboxes to measured state.

**Interfaces:**
- Use Task 1 public HTTP API and Task 2 native UI only. Runner reads credentials inside process from local config; no CLI secret argument or stdout dumps.
- Runner input is explicit source directory plus fixed ten filenames from spec and output directory. It submits all ten and snapshots job IDs/results; resumable by persisted idempotency keys. It does not confirm questions or invent golden answers.

- [ ] RED/GREEN: runner dry-run fails missing source, unsafe endpoint, or mismatched manifest; run tests against local service fixture and record boundaries.
- [ ] Root recheck live Bailian using one submitted source through actual service; preserve error if access fails. Do not start all-model survey, activate new paid models or change proxy settings.
- [ ] Root submit ten existing full source JPEGs, including one from native Photos UI; remaining direct API runs explicitly labelled. Maintain actual service progress and preserve all attempts. Read original source images before judging outputs.
- [ ] Verify user-marked cases: IMG_5518 Q13 incomplete grounding, IMG_5517 Q4 control, IMG_5516 Q14 original arithmetic, IMG_5515 top Q1(4) coverage. Do not constrain inventory to these labels.
- [ ] Confirm only independently source-reviewed material in isolated acceptance collection; do not fill personal reflection on user's normal collection. Test reflection entries explicitly identified as QA data, not student opinion.
- [ ] Produce PDF via native UI, inspect every rendered page for stem/diagram coverage and absence of original answers; run PDFKit text/geometry check.
- [ ] Final review receives scoped before/after diff, actual test evidence and unresolved case list. Fix Critical/Important findings before declaring completion; leave unfinished model/case gates explicitly open. No commit/push/merge.

## Preflight review

Task 1 and 2 share only documented HTTP shapes; Task 2 waits for Task 1 review and frozen examples. Task 3 consumes both and never writes human-confirmed flags automatically. Existing fixtures/legacy records are not acceptance data. Work is uncommitted by user instruction: review packages must use explicit file snapshots, not an empty HEAD-to-HEAD diff. Artifact generation scripts may write their scoped outputs; source edits use apply_patch.
