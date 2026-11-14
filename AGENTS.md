# AGENTS.md

This file provides guidance to the AI agent when working with code in this repository.

## Current handoff (2026-10-15)

Read `docs/CODEX_CLOUD_HANDOFF.md` first for the current product, entry points, verification evidence, and pending acceptance. `main` is the sole authoritative development and production branch. Create a short-lived `codex/<task>` branch from current `origin/main` and open its PR against `main`. See `docs/BRANCHES.md` for preserved unmerged work and archived designs. The native iPhone client is maintained long-term on `ios/main` (Swift changes there; server changes still land on `main` first and are merged into `ios/main`), see `docs/ios-native-invitation-login.md`. `.ai/tasks/current/` and early PRD/manual files contain historical status, not the current release state.

Primary student surface: mobile browser `/s/`, per-student invitation login, server-owned learning records. The last manual release baseline is `0.5.0-r2`; after CI/CD activation, read the latest successful production Action and server release manifest for the current version. The user has confirmed successful real-phone photo upload. iOS is retained but is not the current distribution path.

## What this is

纸错题延迟重做闭环 MVP — TypeScript · Express 5 · node:sqlite · sharp. Production entry: `src/main.ts` (built as `dist/main.js`), with `/s` invitation gateway in `src/studentHost/`. `src/server.ts` / `src/app.ts` are the older local demo. iOS client lives in `iOS/` (Xcode project).

**Student UI (2026-10-23 onward)**: an Ionic React single-page app in `client/` (Vite, iOS mode) served at `/s/`, `/s/new`, `/s/q/:id`, `/s/me`, talking to the JSON API in `src/web/api.ts` (`/s/api`). Read `docs/CLIENT_APP.md` first. The older React 19 SSR pages under `src/web/views/` (form-driven, no hydration) are still served on their old paths (`/s/items`, `/s/photos`, `/s/practice/*`, …) but have no entry points from the app; do not extend them. Practice is "coming soon" and deliberately has no UI.

## Commands

- `npm run dev` — dev server, port **3100** (not the framework default)
- `npm run client:watch` — rebuild the Ionic client into `dist/client` on change (the server reads it per request); `npm run client:build` once
- `npm run typecheck` — server and client
- `npm run demo` — generate fixtures + dev server; works with no API key (mock AI mode)
- `npm test` — Vitest unit + integration only
- `npm run web:fake` — synthetic mobile web preview on **3198**; prints a local pairing link (legacy single-student fixture, not invitation login)
- `npm run test:e2e` — Playwright: legacy journeys on **3199**, mobile web on **3196/3197**, invitation/upload fixtures on ephemeral loopback ports; single worker
- `npm run verify` — full gate: typecheck + tests + build + e2e. Run this before considering work done.
- `npx tsx .claude/skills/verify-sel/src/cli.ts` — local student-app proof (launch, doctor, drive, evidence, cleanup). Canonical skill: `.claude/skills/verify-sel/SKILL.md`. A change to student-facing UI (`client/`, invitation/account/install/stage pages) must run it over every entry point of each affected feature in `features/` and link the screenshots in the PR. This does not replace `npm run verify`. Leftover server-rendered pages (`/s/items`, `/s/photos`, `/s/practice/*`, …) are not current features.
- Node >= 24 required. Install Playwright Chromium before `npm test` (fixture generation needs it). See the cloud setup commands in `docs/CODEX_CLOUD_HANDOFF.md`. Claude Code cloud sessions run `.claude/hooks/session-start.sh` at startup, which installs Node 24, npm deps and the matching Playwright Chromium automatically.

## Gotchas

- **AI modes**: `SEL_AI_MODE` = `mock` (default) / `bailian` / `openai`. Real mode with missing config **fails hard — never silently degrade to mock**. Mock mode writes to `data/`; real mode writes to `data/real/`.
- **E2E proxy issue**: Playwright config deletes all `*_PROXY` env vars — local proxies break the health check with 502. Don't re-add them.
- **Crop/extraction integrity**: an AI call returning `succeeded` does NOT mean content passed. Missing/uncertain/unchecked/stale results must not flow into confirmation, diagnosis, or printing. Editing a crop rect invalidates its prior check. See `docs/CROP_COMPLETENESS.md`.
- **Domain rules** (do not weaken): AI only extracts and suggests — reflections must be submitted by the student; same-day correct answers don't count as mastery (only delayed 3–7 day rework); parents see aggregate stats only, never questions or reflections.
- `data/`, `data-e2e/`, `dist/`, `test-results/` are local artifacts — don't commit. Never commit `.superpowers/`, real student photos/audio, invitation codes, session tokens, or `.env` secrets.
- Upload compatibility: browser converts decodable images (including HEIC on supported Safari) to a real JPEG, longest edge 4096. Preserve timeout/retry/idempotency behavior in `client/src/lib/uploader.ts` (ported from `src/web/photoUpload.ts`); server limits still apply.
- Current v2 flow does not require students to verify every question. Low-confidence evidence is retained with original crops and print warnings; do not reinterpret older manual-verification docs as a request to add a compulsory confirmation gate.
- GitHub CI uses synthetic data/mock providers. The user approved automatic deployment after a green push to `main`; see `deploy/ci/README.md`. PRs, tags and other branches never deploy. Production data cleanup, credential changes, and incompatible database migrations still require separate authorization. Review deployment/workflow changes carefully.

## Style & commits

- TypeScript ESM (`"type": "module"`), `tsx` for running TS directly.
- Commit style: `type(scope): summary` (e.g. `feat(api): add classification endpoint`).
- Current engineering handoff is `docs/CODEX_CLOUD_HANDOFF.md`; current specs/release evidence are linked there. `.ai/tasks/current/` is preserved history. Check these before large changes.

## Issue 流程

发现问题或需求时开 GitHub issue（模板在 `.github/ISSUE_TEMPLATE/`：缺陷、需求；仍允许空白 issue）。标题、正文和截图不要写学生姓名、手机号或邀请码。

1. **方案**。`issues: opened` 触发 `.github/workflows/issue-notify.yml`，把 `{repo, number, title, url, author}` POST 给 Grok Bot。地址和 `Authorization` 头只放在 secrets `GROKBOT_ISSUE_WEBHOOK_URL`、`GROKBOT_ISSUE_WEBHOOK_AUTH`（后者是完整头值，不入库、不打印）。作者 `type` 为 `Bot`，或登录名以 `[bot]` 结尾，则跳过。任一 secret 为空时打 `::warning::` 并成功退出。工作流不 checkout、不跑第三方 action、不执行 issue 正文。Bot 在 issue 里贴方案（问题理解、实现方案、影响范围、测试计划、风险）并通知维护者。此阶段标签是 `方案待确认`。
2. **开工**。维护者回复「开工」后，实现助手从最新 `origin/main` 开 `codex/issue-<n>`，跑 `SEL_AI_MODE=mock npm run verify`，向 `main` 开 PR，正文写 `Closes #<n>`，并把本地测试、Actions 检查、线上运行、用户验收分开写。另一名助手独立补回归测试，结果写进 PR 评论。此阶段标签是 `开发中`。
3. **审查**。沿用 Codex 自动 review，再加一名独立审查助手。有问题打回实现方修。审查进行中的标签是 `待审查`。
4. **合并**。CI 全绿且审查通过后通知维护者，标签改为 `待合并`。只有维护者确认后才 squash 合并，并跟踪 main 的 CI 和生产发布，直到明确成功或失败。改到 `dist/db` 或 `dist/studentHost/registry.js` 时，自动发布会因迁移保护拒绝；必须维护者单独同意后走人工发布，不能绕过。PR、git tag 和其他分支不会部署。

通知工作流不改标签。仓库里需要有这四个标签：`方案待确认`（等维护者回复「开工」）、`开发中`、`待审查`、`待合并`（等维护者确认后 squash 合并）。创建标签要有仓库管理权限；没有这四个标签时，流程说明仍有效，只是没法把阶段贴到 issue 上。
