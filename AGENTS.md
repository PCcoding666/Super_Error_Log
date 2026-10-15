# AGENTS.md

This file provides guidance to the AI agent when working with code in this repository.

## Current handoff (2026-10-15)

Read `docs/CODEX_CLOUD_HANDOFF.md` first for the current product, entry points, verification evidence, and pending acceptance. `main` is the sole authoritative development and production branch. Create a short-lived `codex/<task>` branch from current `origin/main` and open its PR against `main`. See `docs/BRANCHES.md` for preserved unmerged work and archived designs. `.ai/tasks/current/` and early PRD/manual files contain historical status, not the current release state.

Primary student surface: mobile browser `/s/`, per-student invitation login, server-owned learning records. The last manual release baseline is `0.5.0-r2`; after CI/CD activation, read the latest successful production Action and server release manifest for the current version. The user has confirmed successful real-phone photo upload. iOS is retained but is not the current distribution path.

## What this is

纸错题延迟重做闭环 MVP — TypeScript · Express 5 · React 19 SSR (form-driven, **no hydration**) · node:sqlite · sharp. Production entry: `src/main.ts` (built as `dist/main.js`), with `/s` invitation gateway in `src/studentHost/`. `src/server.ts` / `src/app.ts` are the older local demo. iOS client lives in `iOS/` (Xcode project).

## Commands

- `npm run dev` — dev server, port **3100** (not the framework default)
- `npm run demo` — generate fixtures + dev server; works with no API key (mock AI mode)
- `npm test` — Vitest unit + integration only
- `npm run web:fake` — synthetic mobile web preview on **3198**; prints a local pairing link (legacy single-student fixture, not invitation login)
- `npm run test:e2e` — Playwright: legacy journeys on **3199**, mobile web on **3196/3197**, invitation/upload fixtures on ephemeral loopback ports; single worker
- `npm run verify` — full gate: typecheck + tests + build + e2e. Run this before considering work done.
- Node >= 24 required. Install Playwright Chromium before `npm test` (fixture generation needs it). See the cloud setup commands in `docs/CODEX_CLOUD_HANDOFF.md`.

## Gotchas

- **AI modes**: `SEL_AI_MODE` = `mock` (default) / `bailian` / `openai`. Real mode with missing config **fails hard — never silently degrade to mock**. Mock mode writes to `data/`; real mode writes to `data/real/`.
- **E2E proxy issue**: Playwright config deletes all `*_PROXY` env vars — local proxies break the health check with 502. Don't re-add them.
- **Crop/extraction integrity**: an AI call returning `succeeded` does NOT mean content passed. Missing/uncertain/unchecked/stale results must not flow into confirmation, diagnosis, or printing. Editing a crop rect invalidates its prior check. See `docs/CROP_COMPLETENESS.md`.
- **Domain rules** (do not weaken): AI only extracts and suggests — reflections must be submitted by the student; same-day correct answers don't count as mastery (only delayed 3–7 day rework); parents see aggregate stats only, never questions or reflections.
- `data/`, `data-e2e/`, `dist/`, `test-results/` are local artifacts — don't commit. Never commit `.superpowers/`, real student photos/audio, invitation codes, session tokens, or `.env` secrets.
- Upload compatibility: browser converts decodable images (including HEIC on supported Safari) to a real JPEG, longest edge 4096. Preserve timeout/retry/idempotency behavior in `src/web/photoUpload.ts`; server limits still apply.
- Current v2 flow does not require students to verify every question. Low-confidence evidence is retained with original crops and print warnings; do not reinterpret older manual-verification docs as a request to add a compulsory confirmation gate.
- GitHub CI uses synthetic data/mock providers. The user approved automatic deployment after a green push to `main`; see `deploy/ci/README.md`. PRs, tags and other branches never deploy. Production data cleanup, credential changes, and incompatible database migrations still require separate authorization. Review deployment/workflow changes carefully.

## Style & commits

- TypeScript ESM (`"type": "module"`), `tsx` for running TS directly.
- Commit style: `type(scope): summary` (e.g. `feat(api): add classification endpoint`).
- Current engineering handoff is `docs/CODEX_CLOUD_HANDOFF.md`; current specs/release evidence are linked there. `.ai/tasks/current/` is preserved history. Check these before large changes.
