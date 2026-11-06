# Super Error Log

Mobile web **mistake notebook** for Chinese secondary students: photograph worksheets, let AI find marked mistakes, and keep a personal notebook. Practice / delayed redo is **coming soon**.

Live:

- Student app: https://study.pccoding666.com/s/
- Illustrated guide: https://study.pccoding666.com/help/
- Register: https://study.pccoding666.com/s/register
- Recover invite: https://study.pccoding666.com/s/recover

Product UI is Chinese. GitHub text (README, issues, PRs, commits) is English.

## What it does today

**Students** (phone browser, add-to-home-screen):

1. Register with name + phone + a self-chosen 4-digit recovery PIN → receive a 12-digit invite code (shown once). Login at `/s/` with that code; recover at `/s/recover` if forgotten.
2. Photograph or pick from album (**single-page** or **multi-page** capture). AI finds problems; marked mistakes go into the notebook; unmarked pages need a student check before adding.
3. Review the notebook (`/s/`), intake queue (`/s/new`), item detail with the full original page (`/s/q/:id`), and settings / invite (`/s/me`). Edit OCR, add answer photos, voice or typed remarks. Materials intake can filter uploads by Singapore calendar day (`Asia/Singapore`).
4. Subjects currently supported: math, physics, chemistry. Practice is listed as **coming soon** in settings — no practice UI in this release.

**Teachers / admins:**

- Invite and account tools via server CLI (`dist/studentHost/admin-cli.js`); optional class registration codes.
- Read-only usage dashboard at `/admin/` (separate admin password; tokens, latency, success/failure — no student content).
- Ops runbook: [deploy/ops/RUNBOOK.md](deploy/ops/RUNBOOK.md).

**Not in the current student web product:** parent portal, variant-problem generation, and the delayed paper-redo practice loop (code paths may still exist without UI entry points).

## Principles

- **AI suggests; the student decides.** Reflections and results are never auto-submitted by the model.
- **Same-day correct ≠ mastery.** When practice returns, only delayed independent redo counts (see domain rules in `AGENTS.md`).
- **Minors’ data is minimized.** Invite codes are hashed; photos are stripped of EXIF and stored per student; parents (when enabled) see aggregates only. Details: [docs/privacy/PRIVACY_AND_MINOR_DATA.md](docs/privacy/PRIVACY_AND_MINOR_DATA.md).

## Architecture (high level)

```
Phone browser (Ionic React SPA in client/)
        │ HTTPS
        ▼
Caddy → studentHost gateway (src/studentHost/)
        ├── /s/login · /s/register · /s/recover · sessions
        ├── /admin/  (host process only)
        ├── /help/   (product guide)
        └── per-student worker process
              ├── Ionic app shell + /s/api + materials upload
              ├── AI provider (mock | bailian | openai-compatible)
              └── private SQLite + uploads under that student’s dir
```

- Production entry: `src/main.ts` → `dist/main.js` (Node ≥ 24).
- Student UI: Ionic React (`client/`), Vite build into `dist/client`, served under `/s/` and `/s/app/assets/`. See [docs/CLIENT_APP.md](docs/CLIENT_APP.md).
- AI: `SEL_AI_MODE=mock|bailian|openai`. Real mode **fails hard** if misconfigured — never silently falls back to mock. Stage models are configurable; see `.env.example`.
- Native iPhone (SwiftUI) lives on branch `ios/main` under `iOS/`; it is not the current distribution path. There is no Android native shell; Android students use the mobile browser / PWA.

Deeper docs: [docs/architecture/](docs/architecture/), [docs/CODEX_CLOUD_HANDOFF.md](docs/CODEX_CLOUD_HANDOFF.md), [AGENTS.md](AGENTS.md).

## Local development

```bash
npm install
# optional: Playwright Chromium (needed for some fixtures / e2e)
npx playwright install chromium

SEL_AI_MODE=mock npm run demo   # fixtures + dev server on :3100
# or
SEL_AI_MODE=mock npm run dev

# rebuild the Ionic client while the server runs
npm run client:watch
```

| Script | Purpose |
| --- | --- |
| `npm run dev` | Server with `tsx watch` (port **3100**) |
| `npm run demo` | Generate fixtures + `dev` (mock AI, no API key) |
| `npm run client:build` / `client:watch` | Ionic SPA → `dist/client` |
| `npm run typecheck` | Server + client TypeScript |
| `npm test` | Vitest unit/integration |
| `npm run test:e2e` | Playwright e2e |
| `npm run verify` | typecheck + build + unit + e2e (full gate) |
| `npm run build && npm start` | Production build + `dist/server.js` (local); production cloud entry is `dist/main.js` |

Copy `.env.example` to `.env` for real AI. Keep secrets out of git and chat.

## Testing

Prefer `SEL_AI_MODE=mock npm run verify` before opening a PR. CI runs the same class of checks with synthetic data only — never real student photos, invite codes, or production keys.

## Deployment

Hosted on Alibaba Cloud ECS behind Caddy at `study.pccoding666.com`. Merge to `main` with green CI triggers automatic production release (see [deploy/ci/README.md](deploy/ci/README.md)). PRs, tags, and other branches never deploy.

- Install / env / Caddy / ops: [deploy/README.md](deploy/README.md)
- Day-to-day ops & alerts: [deploy/ops/RUNBOOK.md](deploy/ops/RUNBOOK.md)
- Release checklist: [docs/quality/RELEASE_CHECKLIST.md](docs/quality/RELEASE_CHECKLIST.md)

**Migration guard:** changes that alter `dist/db/` or `dist/studentHost/registry.js` cause auto-release to refuse. Those need an explicit maintainer-approved **manual release** — do not bypass the guard.

## Issue → release workflow

1. **Issue opened** → `.github/workflows/issue-notify.yml` notifies the maintainer bot → bot posts an English **plan** comment. Label: `plan-proposed`.
2. Maintainer replies to start work → implement on a short-lived branch from latest `origin/main`, open a PR with `Closes #<n>`, run `SEL_AI_MODE=mock npm run verify`. Label: `in-progress`.
3. Independent review + CI. Label: `in-review`.
4. When CI and review pass: label `ready-to-merge`. **Only the maintainer merges** (squash). Track main CI and the production release until success or failure.

Labels: `plan-proposed` · `in-progress` · `in-review` · `ready-to-merge`. Do not put student names, phones, or invite codes in issues, screenshots, or commits.

## Privacy

This product handles minors’ learning data. Collect only what registration and learning need; hash invite codes and session tokens; strip EXIF from photos; keep per-student isolation; never commit real student content. Full note: [docs/privacy/PRIVACY_AND_MINOR_DATA.md](docs/privacy/PRIVACY_AND_MINOR_DATA.md).

## Docs map

| Path | Contents |
| --- | --- |
| [docs/product/](docs/product/) | PRD, product spec, student guide source |
| [docs/CLIENT_APP.md](docs/CLIENT_APP.md) | Ionic student app structure & `/s/api` |
| [docs/architecture/](docs/architecture/) | Architecture, data model, AI provider contract |
| [docs/privacy/](docs/privacy/) | Privacy & minor-data rules |
| [docs/quality/](docs/quality/) | Test strategy, release evidence |
| [docs/BRANCHES.md](docs/BRANCHES.md) | Branch rules & archived work |
| [AGENTS.md](AGENTS.md) | Agent handoff, commands, gotchas |

## Stack

TypeScript · Express 5 · Ionic React (Vite) · node:sqlite · sharp · Vitest · Playwright · Caddy · systemd on Alibaba Cloud Linux
