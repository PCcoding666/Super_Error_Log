# Evidence pipeline implementation plan

> **For agentic workers:** Use superpowers:executing-plans for tightly coupled integration and superpowers:subagent-driven-development for the isolated image task and its review. Steps use checkbox syntax.

**Goal:** Make the real question evidence workflow usable and produce honest, bounded Bailian stage evaluations.
**Architecture:** Extend the current app with evidence records and a staged provider. Reuse the same stage methods in evaluation and the application. Deterministic code crops images, validates output, selects tasks and updates learning state.
**Tech Stack:** Node >=24, TypeScript, Express, React SSR, SQLite, sharp, macOS sips fallback, Vitest, Playwright.
**Spec:** docs/superpowers/specs/2026-09-07-evidence-pipeline-design.md

## Global Constraints

- 保留用户已有未提交修改；不 commit、push、部署或删除旧数据。
- 原始 HEIC 只读；转换、裁图、真值和实测输出存放 git-ignored 本地目录。
- 密钥只从本机配置读取，不能进入日志、报告、浏览器或 Git。
- AI 建议、学生确认、真实重做结果三者分离；禁止伪造学生输入。
- 原图和私人反思仍受学生权限保护。
- 10 道技术验收不等于完成延迟学习验证。

## Task 1: Faithful image normalization and region crops

**Files:** Create `src/media/images.ts`, `tests/unit/images.test.ts`. Do not modify other production files.
**Interfaces:** Export `Box = {x:number;y:number;width:number;height:number}`, `validateBox(value:unknown):Box`, `normalizePhoto(buffer:Buffer):Promise<Buffer>`, `cropPhoto(buffer:Buffer, box:Box):Promise<Buffer>` and `isHeif(buffer:Buffer):boolean`. Coordinates are fractions 0..1 against the upright normalized image. Root will integrate consumers.

- [ ] RED: tests exercise invalid finite/range/zero boxes, known colored synthetic crop pixels, EXIF rotation stripping, malformed data and HEIC decoding on macOS. Mutation: crop returns whole source, accepts out-of-bounds box, or loses orientation.
  ```ts
  expect(() => validateBox({x:.9,y:0,width:.2,height:1})).toThrow();
  expect(() => validateBox({x:0,y:0,width:0,height:1})).toThrow();
  ```
- [ ] GREEN: sharp handles common images; for actual HEIF on Darwin only, bounded execFile of `/usr/bin/sips` converts in a dedicated mkdtemp directory, followed by sharp JPEG/EXIF cleanup. No shell interpolation, no generic fallback on arbitrary binary, maximum input 15MB and decoded 40M pixels; clean only owned temp files. Preserve original bytes. Crop enforces bounds before sharp.extract; return JPEG with no metadata. Accept tiny positive crops with at least one pixel. No generative editing.
- [ ] Run `npx vitest run tests/unit/images.test.ts`. Report RED/GREEN and any platform limitations. No commit. Root separately inspects a converted real image and integrates this API.

## Task 2: Staged model contract and real configuration

**Files:** `src/ai/evidence.ts`, `src/ai/stagedProvider.ts`, `src/ai/chatClient.ts`, `src/config.ts`, `src/ai/index.ts`, `.env.example`, `tests/unit/evidence.test.ts`, `tests/integration/stagedProvider.test.ts`.
**Interfaces:** stages layout/transcribe/diagnose/coach/match; `StagedProvider.layout(input)`, `.transcribe(input,region)`, `.diagnose(evidence)`, `.coach(evidence,diagnosis)`, existing provider methods remain.

- [ ] RED: local HTTP fixture captures actual requests and returns hand-authored JSON. Assert complete question evidence roundtrip, student evidence passed to diagnosis, incorrect region/ref/schema rejected, stage model selected, no real→mock fallback, and `.env` loads in a fresh process without overwriting explicit env.
  ```ts
  expect(() => validateEvidence({version:1,questionText:''})).toThrow();
  expect(validateEvidence(valid).studentWork[0].text).toBe('x = -2');
  ```
- [ ] GREEN: strict bounded schemas, models configurable per stage, nonthinking JSON mode for structured stages, token/latency/usage metadata returned, truncated responses fail, credentials and source bytes never logged. Model restrictions and endpoint safety checked before requests. Existing explicit mock provider remains isolated.
- [ ] Run focused tests and typecheck; preserve original parser contract for mock tests.

## Task 3: Evidence persistence and correction flow

**Files:** `src/db/schema.ts`, `src/services/evidenceService.ts`, `src/services/batchService.ts`, `src/routes/pages.ts`, `src/views/evidence.tsx`, `src/views/items.tsx`, `src/views/batches.tsx`, `src/app.ts`, `tests/integration/evidenceFlow.test.ts`.
**Interfaces:** `getEvidence(itemId)`, `saveEvidence(itemId,content,verified)`, `analyzeEvidence(itemId)`, `getEvidenceCrop(itemId,regionId)`; evidence_record stores extraction/diagnosis/coaching JSON and revision.

- [ ] RED: real extraction creates needs_review, correction roundtrip persists steps and regions, modifying evidence invalidates cached analysis, scheduled evidence cannot change, failed stage remains retriable, guardian cannot access evidence/crops.
- [ ] GREEN: staged provider persists full extracted evidence; source image remains authoritative and immutable. Add manual region/text correction and explicit content confirmation, POST-only diagnostic generation, no background model calls on page GET. Forward verified evidence to diagnosis and display evidence citations; only student reflection submission changes diagnosis ownership.
- [ ] Run integration tests and inspect SSR mobile layout.

## Task 4: Clean print and honest offline return

**Files:** `src/services/printPacket.ts`, `src/services/pdfService.ts`, `src/services/planService.ts`, `src/views/plan.tsx`, `src/services/attemptService.ts`, `src/views/packets.tsx`, `src/domain/types.ts`, `src/routes/pages.ts`, tests integration.

- [ ] RED: nonverified real content blocked, source answer image never printed, diagram-only confirmed crops retained, AI answers labeled unverified, selector actually chooses scored diversity, reprint preserves generated_at, performed date rejects future/preprint dates, failed attempts reenter queue.
- [ ] GREEN: build PDF from confirmed question text and clean diagram crops, separate hints/answers; snapshot print inputs by prohibiting editing packet-bound items. Preserve first-generation timestamp and record performed_at separately from submitted_at.
- [ ] Run test/build and Playwright with a new temporary data directory, never destructive globalSetup. Render PDF and visually inspect formula/diagram readability and answer separation.

## Task 5: Bounded real model evaluation and pilot handoff

**Files:** `src/evaluation/runner.ts`, `src/evaluation/scoring.ts`, `src/evaluation/catalog.ts`, `src/cli/evaluate.ts`, `tests/unit/evaluation.test.ts`, `docs/REAL_PILOT.md`, `package.json`.

- [ ] RED: missing costs/credentials/ground truth cannot run live or rank; failures count in denominator; budget reserves worst-case tokens before request; score cards require explicit human review; paired input sets required for comparison.
- [ ] GREEN: manifest specifies private source paths, reviewed stage input, expected facts, region, candidate model settings and rates. Persist one local result per call with hash/version/usage/duration/error; resume avoids rerunning completed calls. Rank per stage only on complete reviewed same samples, with critical-error gate and ties explicit. No automatic winner installation.
- [ ] Prepare 10-question dataset from authorized photos with manual evidence checks; run bounded real calls once local config/region/cost cap are available. Keep student reflections and delayed attempts pending.
- [ ] Report actual implementation/test status, model comparison scope, remaining failures, configuration and sources. Never report unrun models as best.
