# Issue #121 — progressive intake

Scope: Ionic `client/` and `/s/api`, based on main `6808d43`. No schema, registry, AI concurrency, production data or environment changes. #115 / PR #122 is independent and is not included.

## Behavior

- A successful locate publishes source-bound question boxes in the extraction job's existing JSON. Intake shows local crops immediately and polls every 3 seconds while the job runs.
- Read text is explicitly unchecked; verification progressively updates status. Preview fragments never enter `material_fragment`, `material_question`, or the notebook by themselves.
- Candidate identity is `fragmentId:sourceRevision`, retained from the durable locate checkpoint through enrichment, retries and the final projection. Existing `questionId:revision` clients remain accepted.
- Policy A: “加入” persists the selection first. A trustworthy complete reconciled stem/diagram is required to create the error-book item. Polling and reopening recover submitted selections. Verified teacher crosses alone cannot auto-file an untrusted stem.
- Preview detail and crop endpoints are read-only, scoped to the owner and original source revision/hash. Cropping uses the existing process/parent image permit; no extra AI requests or raised concurrency.

## Measurement definitions and limits

`IntakePhoto.progress` includes stage, total regions, verified regions, first-batch question-region count, `tLocateDoneMs`, `tFirstSelectableMs`, and `tFullExtractMs`.

These server timings begin at the persisted job creation time (SQLite timestamp precision) and end at publication/final persistence. `tFirstSelectableMs` means candidates are available to the API, not that a browser has loaded the crop. Client latency additionally includes upload, polling (0–3 seconds), network and local crop rendering. Full-extract time stays null on failure/partial completion.

The Playwright slow-enrichment case measures upload-to-interactive candidate with synthetic input, then proves text can arrive without losing the selection and that a submitted selection survives reload before any notebook write. This proves the removed pipeline dependency, not a real-model latency percentile. The local HTTP protocol test independently proves the first preview is emitted while read is blocked and that the pipeline still makes exactly locate + read + verify calls for one fragment.

Typical real workbook `t_first_selectable` P50 ≤30s, real first-batch retention after enrichment, and auto-file false-positive rate have **not been measured** in this change. Do not infer these from synthetic tests or from a successful model request. Measure them on an isolated representative single-page set before claiming the performance target, and distinguish source-upload time from task processing time.

## Validation record

- Provider/extraction protocol: 38 passing in the first focused run; new slow-read test failed on the base behavior before implementation.
- Independent API regression: 14 tests failed against base `6808d43`, then passed. Source revision/hash, student/photo isolation, read-only endpoints, deferred selection across reopened SQLite readers and retry/partial failures are covered. The image-permit test independently reproduced concurrent crop decoding before the gate was added.
- Independent code review found four trust/lifecycle gaps: wrong-subpart diagram, omitted same-number continuation, automatic filing during intermediate fragment links, and abandoned previews. All four have reproducing tests (4 RED → 4 GREEN); combined material/progress regression passed 58 tests after fixes. The final extraction and retained locate regions now both constrain automatic filing, including providers that do not publish previews.
- Playwright: slow background extraction and terminal uncertain-selection recovery each passed (2/2). The latter failed before correcting the misleading pending wording.
- Final-code full gate: typecheck and build passed; Vitest **148 files, 1718 passed / 5 skipped**. Full Playwright initially hit an existing hard-coded `/opt/cursor/artifacts` permission error in `captureModeMaterials.spec.ts`. Screenshot output now uses `test.info().outputPath`; that same failed case passed on its focused rerun (1/1). This changes test artifacts only.
- Full-browser and Actions outcomes are kept current in [PR #123](https://github.com/PCcoding666/Super_Error_Log/pull/123). No deferred minor review findings.

## Production and acceptance

Not deployed. No real student photos or production records were used. Real iPhone/Android acceptance and real-model latency remain pending. PR checks do not deploy; merging main follows the existing authorized release workflow and still requires maintainer confirmation under AGENTS.md.
