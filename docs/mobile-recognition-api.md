# Mobile Recognition API v1

This local API connects the SwiftUI student app to the Mac-hosted Bailian recognition worker. It is a separate collection from the web app database and listens on `127.0.0.1:3101` by default. Every `/v1` request, including health, requires the local pairing token:

```http
Authorization: Bearer <SEL_MOBILE_PAIRING_TOKEN>
```

All responses use `Cache-Control: private, no-store`. A successful job response is `{ "job": RecognitionJob }`; the collection response is `{ "jobs": RecognitionJob[] }`; errors are always:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "请求正文不合法。"
  }
}
```

## Configuration and startup

The service reads the repository-root `.env` without printing credentials. Real mode is fail-closed: it requires `SEL_MOBILE_AI_MODE=bailian` (or `SEL_AI_MODE=bailian`), the exact Beijing endpoint `https://dashscope.aliyuncs.com/compatible-mode/v1`, a nonempty key, a nonempty model for every stage, and a pairing token of at least 16 characters. It never falls back to mock data.

| Variable | Default or fallback |
| --- | --- |
| `SEL_MOBILE_MODE` | `loopback`; `cloud` enables the Guangzhou cloud deployment profile; any other value is rejected |
| `SEL_MOBILE_PAIRING_TOKEN` | required in loopback mode; unused in cloud mode (device tokens replace it); independent of the Bailian key |
| `SEL_MOBILE_AI_BASE_URL` | falls back to `SEL_AI_BASE_URL`; must equal the Beijing endpoint |
| `SEL_MOBILE_AI_API_KEY` | `SEL_AI_API_KEY`, then `DASHSCOPE_API_KEY` |
| `SEL_MOBILE_AI_MODEL` | falls back to `SEL_AI_MODEL` |
| `SEL_MOBILE_AI_MODEL_INVENTORY` | mobile common model |
| `SEL_MOBILE_AI_MODEL_TRANSCRIBE` | mobile common model |
| `SEL_MOBILE_AI_MODEL_VERIFY` | mobile common model |
| `SEL_MOBILE_AI_MODEL_GROUND` | mobile common model |
| `SEL_MOBILE_AI_TIMEOUT_MS` | `90000` (90 seconds per model call; same stage still retries at most twice) |
| `SEL_MOBILE_DATA_DIR` | `data/mobile-recognition` |
| `SEL_MOBILE_PORT` | `3101` |
| `SEL_MOBILE_HOST` | `127.0.0.1`; other values are rejected |

Development: `npm run mobile:dev`. Built service: `npm run build && npm run mobile:start`.

For a pilot launch, the pairing token may be injected into the launch process from a local mode-`0600` token file instead of editing the repository `.env`. Do not place either token or Bailian key in command-line arguments or print them to terminal output. The startup message contains only the loopback address and port. Keep the token file outside version control and load it into the process environment before starting the service.

## Pairing (cloud mode)

In cloud mode the shared pairing token is disabled: `/v1` authentication uses per-device tokens, and the public app exposes the pairing redemption endpoint:

```http
POST /v1/pairing/redeem
Content-Type: application/json
X-Real-IP: (set by Caddy header_up — clients cannot spoof it)
```

```json
{ "payload": { /* PairingCodePayload from the QR code */ }, "clientId": "8b411cca-f903-4d8c-a5d0-41435e2a66bb", "deviceInfo": "iPhone 17 Pro" }
```

`clientId` is a UUID the phone generates once and persists. The request body is capped at 16 KB. Success returns `RedeemResult` (200). Same client + same secret within the validity window returns the identical result (idempotent recovery). A different concurrent client on one session: exactly one wins, the other gets `409 pairing_used`; an expired session is `410 pairing_expired`; a malformed payload is `400`. The endpoint needs no Authorization header; every redeem failure counts toward the pairing rate limits.

Rate limits (cloud mode, per rolling minute, 429 + `Retry-After`): pairing failures 10 per source IP plus 60 global; authentication failures 30 per source IP; authenticated queries 300 per device. Source IP is derived only from the local reverse proxy's overwritten `X-Real-IP` header when the app runs with `cloudProxy` and the direct peer is loopback; forged headers from any other path are ignored and the direct peer address is used.

### Admin entry (Unix domain socket only)

The admin entry listens on `<dataDir>/admin.sock` (parent directory `0700`, socket file `0600`) inside the same service process. It is reachable only from the server machine itself — over SSH — and the public app exposes **no** admin routes. The admin CLI client is `src/mobile/admin-cli.ts` (built: `dist/mobile/admin-cli.js`):

```sh
node dist/mobile/admin-cli.js --data-dir /var/lib/super-error-log pairing-code
node dist/mobile/admin-cli.js --data-dir /var/lib/super-error-log devices
node dist/mobile/admin-cli.js --data-dir /var/lib/super-error-log revoke <deviceId>
```

The `serve` subcommand runs the admin entry standalone. Since Task 2 the cloud-mode main process (`assembleCloudService`, used by `server.ts` with `SEL_MOBILE_MODE=cloud`) embeds both: the public app with device-token auth and the admin socket in one process.

`GET /pairing-code` (over the socket) returns a fresh one-time QR payload:

```json
{
  "payload": {
    "v": 1,
    "serviceId": "e8383d01-d47e-40e0-b0a1-61a7d81b8665",
    "httpsUrl": "https://8.163.96.197",
    "sessionId": "099ea4a5-e4bf-4182-b986-a9fc7db383e9",
    "secret": "2_39bX4iG76643WfiJRfvW-jYJVxbBdm9ACmHrgGjJ0"
  },
  "expiresAt": "2026-09-17T11:15:42.517Z"
}
```

`httpsUrl` is one of two fixed entry points: `https://8.163.96.197` (IP, default since 2026-10-03; self-signed certificate pinned in the app, see `deploy/README.md` §9) or `https://study.pccoding666.com` (domain, kept). `SEL_MOBILE_PAIRING_URL` selects which one the QR carries; redeem accepts either, but only the exact value the session issued. The app rejects any other address and keeps using the entry it scanned.

Semantics: the secret is 32 bytes base64url, valid 5 minutes, single use. `serviceId` is atomically initialized once per data directory and never rotates. Redeeming with the same client ID and secret within the validity window returns the identical result (in-memory recovery only; after a service restart the session is gone and the phone must rescan). Two different concurrent redeemers on one session: exactly one wins, the other gets `pairing_used`.

Each redeemed device receives a 32-byte token (30-day expiry, individually revocable). Tokens are persisted as SHA-256 hashes only — `devices.json` (mode `0600`) never contains a plaintext token, and admin responses never echo one. A durable write must succeed before the token is returned; on failure the session stays unredeemed and the redeem can be retried. `GET /devices` lists device records without hashes; `POST /devices/:id/revoke` invalidates one device immediately and idempotently. Unknown paths return `404`; all other methods are rejected.

### Web pairing link (student web client, 2026-10-09)

The same one-time session can also be redeemed by the student web client at `/s/`. `admin-cli pairing-code` prints, after the QR payload, a link `https://study.pccoding666.com/s/pair?code=<base64url(JSON payload)>` (`--web-base` picks another trusted HTTPS hostname). Opening the link shows a confirmation page; the redeem happens only when the student taps 「连接这台手机」, through the same `PairingManager.redeem` (same expiry, single use, same failure rate limit). The resulting device token is stored in an httpOnly cookie `sel_device` (`Path=/s`, `SameSite=Lax`, `Secure` on non-local hosts) and is checked with the same authentication and per-device rate limits as `/v1` and `/v2`. The cookie is never sent to `/v1` or `/v2`. The web pages call the services in-process; the only JSON endpoint they use is `POST /s/voice` (mirror of `POST /v2/reflections/transcribe`, see the v2 doc §3.26). The web link host must be trusted by Safari: the IP entry's self-signed certificate is pinned by the app only.

## Data types

`RecognitionJob`:

```json
{
  "version": 1,
  "id": "3f7b69dc-9d37-4aaa-b965-bb61243445a0",
  "revision": 8,
  "photoName": "IMG_5517.JPG",
  "sourceHash": "74f97e2d65ed1fa0a6357fb952817417a062c3ddf71b8cc9d94a35d5930cbc69",
  "sourceMediaId": "6ddc034b-b0f8-4288-b9c1-4f496cfb90df",
  "status": "partial",
  "phase": "complete",
  "inventoryWarnings": ["页面右缘有残缺候选"],
  "questions": [
    {
      "id": "a42b4eb2-12ff-499f-92de-e49d7cb36ef7",
      "number": "4",
      "revision": 3,
      "status": "ready",
      "selectionEvidence": "marked_wrong",
      "evidence": {
        "version": 1,
        "questionNumber": "4",
        "questionText": "求 x 的值。",
        "subject": "数学",
        "chapter": "",
        "knowledgeTags": ["方程"],
        "questionType": "计算",
        "questionRegion": { "x": 0.08, "y": 0.2, "width": 0.84, "height": 0.3 },
        "requiresDiagram": false,
        "regions": [
          {
            "id": "student-1",
            "kind": "student_work",
            "box": { "x": 0.2, "y": 0.35, "width": 0.4, "height": 0.12 },
            "confidence": 0.8,
            "cleanForPrint": false
          }
        ],
        "observations": [
          {
            "id": "observation-1",
            "kind": "student_work",
            "text": "2x = 8",
            "regionId": "student-1",
            "confidence": 0.8
          }
        ],
        "uncertainties": []
      },
      "verification": {
        "textComplete": true,
        "questionCropComplete": true,
        "questionCropPure": true,
        "transcriptionMatches": true,
        "diagramSafe": true,
        "issues": []
      },
      "questionMediaId": "1800c1bc-47ab-42bc-a46d-315005bdc695",
      "diagramMediaIds": [],
      "error": null,
      "confirmedAt": null
    }
  ],
  "error": {
    "code": "partial",
    "message": "识别暂未完成，已完成的题目已保留。",
    "stage": "questions",
    "retryable": true
  },
  "createdAt": "2026-09-14T10:00:00.000Z",
  "updatedAt": "2026-09-14T10:01:30.000Z"
}
```

Job statuses are `queued`, `processing`, `completed`, `partial`, `failed`, or `interrupted`; phases are `inventory`, `questions`, or `complete`. Question statuses are `queued`, `processing`, `needs_check`, `ready`, `failed`, `confirmed`, `skipped`, or `unselected`. `selectionEvidence` is one of `marked_wrong`, `corrected`, `unmarked`, or `unclear`; it is evidence about markings, not a declaration that the candidate is an error.

Since v2.1a, inventory splits candidates before any per-question work: `marked_wrong`/`corrected` candidates are queued for deep reading as before; `unmarked`/`unclear` candidates become `unselected` — no work unit, no attempt budget, no model request. `unselected` questions never count as in-progress, failed, or usable: a job whose automatic questions all succeed is `completed` even if unselected questions remain, and a job with no automatic questions at all becomes `completed` (`phase: complete`) as soon as inventory finishes. The student can queue unselected questions for deep reading via `POST /v1/recognitions/:id/select`; such questions carry `selectedByStudent: true` afterwards and are then treated exactly like automatically queued ones. A selection can move a terminal job back to `processing`/`questions`; it reaches a terminal state again when those questions finish.

Every failure has `code`, a student-safe Chinese `message`, `stage`, and `retryable`. Additive `recoverable` describes eligibility for an explicit user-requested failed-stage recovery, not the adapter's automatic retry loop. For example, a repaired verification schema failure is `{ "code": "invalid_output", "message": "模型输出字段不合法", "stage": "verify", "retryable": false, "recoverable": true }`. Old records may lack the field; the service derives it without changing historical attempts, and clients must not infer automatic recovery from absence. Verification booleans are independent and are never inferred from missing data. `questionCropPure` means that the evidence crop does not contain an unrelated neighboring question; this question's own work or correction may still be present. Printable diagrams have the stronger `diagramSafe` gate and must contain no answer/work/correction contamination.

Questions may additionally expose `candidateBox`, e.g. `{ "x": 0.6, "y": 0.1, "width": 0.3, "height": 0.7 }`: the original inventory position in normalized full-source coordinates, NOT a verified question crop. The question UUID identifies the occurrence; a repeated printed number does not. Verification receives the immutable original candidate, UUID and position even after a saved checkpoint; `transcriptionMatches` includes matching this intended occurrence, not just a self-consistent crop elsewhere. Two disjoint same-number inventory candidates whose returned question boxes overlap with IoU ≥0.8 are conservatively held needs_check; neither unconfirmed ambiguous result may be confirmed. Initial and corrected boxes need not be identical. Until other disjoint same-number candidates finish successfully, confirmation is also blocked. Missing legacy position is displayed as unavailable, never invented.

`questionText` is clean Chinese/Unicode text with real line breaks, not Markdown or LaTeX: the model prompt requests unambiguous parentheses for fractions where needed and no fenced code or dollar-delimited formulas. The deterministic validator rejects code fences and clear LaTeX commands/delimiters such as `\frac{...}`, `\(...)`, and `\[...]`; it does not try to parse every dollar sign. Literal source dollars and ordinary text such as `Book A costs $5. Book B costs $10.` or `价格分别是$5和$10，求总价。` are preserved exactly. `questionText` contains only the printed question and never a student's filled-in answer. Handwritten work, handwritten mistakes, correction, teacher notes, and reference answers remain faithful source observations under their separate `kind`; the worker never repairs mathematical content for prettier formatting. A valid intermediate transcription is published in `evidence` as soon as it is durable, so a failed question may have non-null evidence with null or prior verification while its crop media IDs are still null/empty.

## Health

```http
GET /v1/health
Authorization: Bearer <pairing token | device token>
```

```json
{ "version": 1, "realVisionConfigured": true }
```

In cloud mode the same endpoint (device-token authenticated) returns the extended shape:

```json
{
  "version": 1,
  "serviceId": "e8383d01-d47e-40e0-b0a1-61a7d81b8665",
  "storageAvailable": true,
  "visionConfigured": true,
  "acceptingJobs": true,
  "protocolVersion": 1
}
```

`acceptingJobs` reflects the full entry gates: storage availability, the service's RSS observation threshold, pending job capacity, and the disk/data-quota gates. A healthy response proves connection, authorization, and entry readiness only — it is not proof that a model call, credential, or model permission currently works.

If any service-owned durable read/write needed by recognition fails after startup—including source/media, model-attempt, or checkpoint I/O—health immediately changes to `503 storage_unavailable` and the process stops accepting submissions, retries, and confirmations. The storage error is not rewritten as an ordinary model failure even if a later job-record write could have succeeded. Restart only after correcting the storage fault; recovery then marks any still-pending question interrupted rather than pretending the lost mutation completed.

## Submit one photo

```http
POST /v1/recognitions
Authorization: Bearer <pairing token>
Content-Type: image/jpeg
Idempotency-Key: 8b411cca-f903-4d8c-a5d0-41435e2a66bb
X-Photo-Name: IMG_5517.JPG

<raw JPEG bytes>
```

`X-Photo-Name` is optional UTF-8 text encoded with percent encoding. The response is `202 Accepted` only after the queued job, original bytes, direction-correct JPEG, and hashes are durable. Repeating the same UUID with the same source bytes returns the same job. Reusing the UUID with different bytes returns `409 idempotency_conflict`. The bytes themselves must decode as JPEG; a PNG/WebP/HEIF body labelled `image/jpeg` is rejected. Empty, damaged, non-JPEG, over-15-MB, or over-40-megapixel inputs are rejected before a job ID is issued.

Cloud-mode admission (checked in order, before the request body is consumed):

1. Idempotent replay: a key that already maps to a job skips the storage gates and capacity; the body is still parsed under the upload slot.
2. Storage gates: system disk below 3 GiB free → `503 disk_low`; data directory at/over 10 GiB → `503 data_quota`. Both messages direct the user to contact the administrator.
3. Upload slot: at most one request body being parsed at a time; a second concurrent upload gets `429 busy` + `Retry-After` and should retry, not queue.
4. Job capacity: at most 10 pending photos (running ones included); a full queue gets `429 capacity_full` + `Retry-After`. Capacity is released when a job reaches a terminal state (completed/partial/failed), by the service itself.
5. Single-process RSS observation: above the configured admission threshold the service stops accepting new jobs (`health.acceptingJobs=false`) until memory falls back. This is an application-level admission threshold, not a kernel limit. The default follows `SEL_SERVICE_MEMORY_MIB` (4096) and is 512 MiB in the parent process, 256 MiB in a student worker when eight workers may be live. `SEL_RSS_ADMISSION_MIB` overrides the formula. The whole service still shares the systemd cgroup (`MemoryMax`, 4G on the recommended host, 1G on the current small box).

Questions inside one photo stay serial (one question boundary at a time), and the provider stages for that question (inventory, then transcribe, verify, and at most two ground passes) also stay serial. Different photos from the same student run together, up to `SEL_STUDENT_AI_CONCURRENCY` (default 3). Each model call still waits for the parent-process AI permit (`SEL_GLOBAL_AI_CONCURRENCY`). Image work (upload decode/normalize, model-input checks, question/diagram crops) stays on the process image lock and the parent image permit (`SEL_GLOBAL_IMAGE_CONCURRENCY`), because `sharp.concurrency(1)` alone does not guarantee cross-request serialization.

```json
{
  "job": {
    "version": 1,
    "id": "3f7b69dc-9d37-4aaa-b965-bb61243445a0",
    "revision": 1,
    "photoName": "IMG_5517.JPG",
    "sourceHash": "74f97e2d65ed1fa0a6357fb952817417a062c3ddf71b8cc9d94a35d5930cbc69",
    "sourceMediaId": "6ddc034b-b0f8-4288-b9c1-4f496cfb90df",
    "status": "queued",
    "phase": "inventory",
    "inventoryWarnings": [],
    "questions": [],
    "error": null,
    "createdAt": "2026-09-14T10:00:00.000Z",
    "updatedAt": "2026-09-14T10:00:00.000Z"
  }
}
```

The client submits at most ten photos as ten independent requests. Processing is asynchronous; it should poll with short GET requests rather than hold the upload request open.

## List and read jobs

```http
GET /v1/recognitions
GET /v1/recognitions/3f7b69dc-9d37-4aaa-b965-bb61243445a0
Authorization: Bearer <pairing token>
```

The collection endpoint returns `{ "jobs": [...] }` newest first. The item endpoint returns `{ "job": ... }`. A missing or malformed job ID returns `404 not_found`. This collection is local to the paired mobile service and does not read student cookies or the web database.

## Select candidates for deep reading

```http
POST /v1/recognitions/3f7b69dc-9d37-4aaa-b965-bb61243445a0/select
Authorization: Bearer <pairing token>
Content-Type: application/json

{ "questionIds": ["a42b4eb2-12ff-499f-92de-e49d7cb36ef7"] }
```

Queues `unselected` questions for deep reading and marks them `selectedByStudent: true` (revision +1, fresh attempt round). IDs in any other status are ignored, so resubmitting the same selection is idempotent and never pays for a second read. If at least one question transitioned, the job returns to `status: processing`, `phase: questions` (possibly from a terminal state) and the response is `200 { "job": ... }`; if none did, the job is returned unchanged.

Errors: `400 invalid_request` (`questionIds 须为 1–30 个不重复的题目 ID。`) for a non-array, empty or over-30 list, non-UUID entries, or duplicates; `404 not_found` when the job does not exist, or any ID does not belong to the job (`题目不存在。`, the whole request is a no-op); `409 not_selectable` (`这张照片还在找题，稍后再选。`) while the job is still in the inventory phase (queued, running, failed, or interrupted); `429 capacity_full` when the queue is full — the job is unchanged and the selection can be retried later.

## Read a candidate thumbnail

```http
GET /v1/recognitions/3f7b69dc-9d37-4aaa-b965-bb61243445a0/questions/a42b4eb2-12ff-499f-92de-e49d7cb36ef7/candidate
Authorization: Bearer <pairing token>
```

The response is `image/jpeg` with the same headers as the media endpoint: a fresh crop of the job's normalized source at the question's original inventory candidate box (expanded by the same margin as question crops, clamped into the page). Available for any question status — this is how the selection panel renders `unselected` candidates before they have crops of their own. Nothing is persisted. `404 not_found` when the job, question, or candidate box is missing or the source image cannot be read.

## Retry only failed work

Retry a failed/interrupted inventory stage:

```http
POST /v1/recognitions/3f7b69dc-9d37-4aaa-b965-bb61243445a0/retry
Authorization: Bearer <pairing token>
Content-Type: application/json

{ "questionId": null }
```

Retry one retryable failed question:

```json
{ "questionId": "aa16756c-44cc-4a1f-a2dc-93605cbd0b31" }
```

The response is `202 { "job": ... }`. Inventory `null` is accepted only while the job is failed/interrupted in the inventory phase and explicitly recoverable. A question UUID selects only that failed, recoverable question. Schema/truncation and repaired authentication/permission/unsupported-model failures remain excluded from automatic attempts but can be deliberately recovered through this endpoint after repair. This can incur a new model request; the native UI explains that and asks for confirmation. Ready, confirmed and skipped questions, internal/storage/invalid-image failures and unsupported local crop failures return `409 not_retryable`. Existing successful candidate IDs, evidence, crops, and revisions are preserved. A question recovery resumes its exact durable next stage: for example, a valid transcription followed by a verification schema failure restarts at verification without retranscribing or paying for that completed stage. Corrected evidence and the incremented grounding count are checkpointed immediately after a successful grounding response, before local crop rendering. Old records are not automatically resumed on launch/restart; known older schema-field stage labels remain eligible only for an explicit endpoint call. Historical attempts are never replaced.

Each new retained attempt also includes `request.promptHash`: lowercase SHA-256 of `JSON.stringify` of the actual ordered request messages, before image redaction. It is content-derived (including the actual image-message contents), not a manually asserted release version. Model, sourceHash, sanitized full messages, raw response and earlier attempts remain independently retained; historical records without this additive hash are unchanged. Private images/base64 and authorization are still excluded from retained message bodies.

## Confirm or skip a candidate

Confirm the exact current question revision after comparing the source:

```http
POST /v1/recognitions/3f7b69dc-9d37-4aaa-b965-bb61243445a0/questions/a42b4eb2-12ff-499f-92de-e49d7cb36ef7/confirm
Authorization: Bearer <pairing token>
Content-Type: application/json

{ "revision": 3, "action": "confirm", "sourceCompared": true }
```

Confirmation succeeds only for a `ready` question when all five verification booleans are explicitly true, `issues` and `evidence.uncertainties` are empty, the inventory candidate is not edge-partial, and `sourceCompared` is true. When `requiresDiagram` is true, every declared diagram region must also have a real allocated diagram crop; model booleans alone cannot substitute for missing media. A `needs_check` question cannot bypass these gates. The API does not accept replacement evidence in this request. A stale revision or an unmet gate returns `409`.

Skipping needs no evidence or source acknowledgement:

```json
{ "revision": 3, "action": "skip" }
```

A success is `200 { "job": ... }`. The returned job contains the incremented question and job revisions. Skip is rejected with `409 question_active` while that question is queued or processing, preventing an in-flight worker result from silently overwriting the user action.

## Read source and crop media

```http
GET /v1/recognitions/3f7b69dc-9d37-4aaa-b965-bb61243445a0/media/1800c1bc-47ab-42bc-a46d-315005bdc695
Authorization: Bearer <pairing token>
```

The response is `image/jpeg`. Use `sourceMediaId`, `questionMediaId`, and `diagramMediaIds` only. IDs are allocated UUIDs looked up within that job; paths, encoded traversal, and remote URLs are never accepted.

## Recovery, attempts, and privacy

The service runs one photo job at a time and no more than one question model boundary concurrently (Task 3: cloud 2 GiB machine resource protection; the loopback mode converges to the same limit). A job cannot become `completed`, `partial`, or `failed` while any question is still queued/processing. A restart never automatically repeats a paid call: every pending question is marked as an explicit interruption even if an older parent record incorrectly claimed a terminal state. Already durable candidates and stage checkpoints remain readable and can be explicitly retried from their exact next stage. One failed question does not roll back successful questions.

Provider calls make at most three total attempts, and only network failures, timeouts, rate limits, HTTP 408, and transient 5xx responses are retried. Authentication, permissions, unsupported requests, truncation, invalid JSON, and schema rejection stop explicitly.

Local attempt files retain full prompts, bounded response bodies, usage, image byte counts/hashes, stage, and error classification. Each received provider result is offered to durable recording exactly once. If that write fails, its storage error propagates without being remapped or re-recorded as a model failure; health becomes unavailable and restart recovery exposes the pending stage for explicit retry. The final serialized file is also bounded to 3,000,000 bytes; when JSON escaping would cross that bound, `responseRaw` keeps the largest fitting prefix and the record adds `responseTruncatedForStorage: true` plus `responseOriginalBytes`. Attempt files never retain authorization headers or image base64, and configured keys are redacted even if a provider echoes one. Attempt dumps are never returned by the mobile API. The data root and subdirectories use mode `0700`, files use `0600`, and macOS backup exclusion is applied when the store opens. The repository ignores `data/`; tests and acceptance runs should use unique data roots. No claim is made here about provider-side retention.
