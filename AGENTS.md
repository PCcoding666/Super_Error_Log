# AGENTS.md

This file provides guidance to the AI agent when working with code in this repository.

## What this is

纸错题延迟重做闭环 MVP — TypeScript · Express 5 · React 19 SSR (form-driven, **no hydration**) · node:sqlite · sharp. Entry: `src/server.ts` (`src/app.ts` builds the app). iOS client lives in `iOS/` (Xcode project).

## Commands

- `npm run dev` — dev server, port **3100** (not the framework default)
- `npm run demo` — generate fixtures + dev server; works with no API key (mock AI mode)
- `npm test` — Vitest unit + integration only
- `npm run test:e2e` — Playwright journeys J1–J8 on port **3199**, uses isolated `data-e2e/` dir; single worker
- `npm run verify` — full gate: typecheck + tests + build + e2e. Run this before considering work done.
- Node >= 24 required.

## Gotchas

- **AI modes**: `SEL_AI_MODE` = `mock` (default) / `bailian` / `openai`. Real mode with missing config **fails hard — never silently degrade to mock**. Mock mode writes to `data/`; real mode writes to `data/real/`.
- **E2E proxy issue**: Playwright config deletes all `*_PROXY` env vars — local proxies break the health check with 502. Don't re-add them.
- **Crop/extraction integrity**: an AI call returning `succeeded` does NOT mean content passed. Missing/uncertain/unchecked/stale results must not flow into confirmation, diagnosis, or printing. Editing a crop rect invalidates its prior check. See `docs/CROP_COMPLETENESS.md`.
- **Domain rules** (do not weaken): AI only extracts and suggests — reflections must be submitted by the student; same-day correct answers don't count as mastery (only delayed 3–7 day rework); parents see aggregate stats only, never questions or reflections.
- `data/`, `data-e2e/`, `dist/`, `test-results/` are local artifacts — don't commit.

## Style & commits

- TypeScript ESM (`"type": "module"`), `tsx` for running TS directly.
- Commit style: `type(scope): summary` (e.g. `feat(api): add classification endpoint`).
- Engineering process state lives in `.ai/tasks/current/`; product/architecture specs in `docs/` — check these before large changes.
