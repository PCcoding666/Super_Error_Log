# Review rules

These are mistakes this repository has already repeated. Flag them. Do not invent style rules, and do not ask for formal proofs.

- Do not add real student photos, handwriting, names, phone numbers, invitation codes, session tokens, or secrets. Images under help pages and `docs/quality` must be synthetic. Do not widen an image allowlist to admit a real exam photo.
- Student UI lives in `client/` and talks to `/s/api`. Do not add files under `src/web/views/` or new server-rendered routes. Do not grow `scripts/lint/baselines.json` to permit a new view or route. `/s/native` is the iOS client only.
- Do not open the system photo picker or start an upload before `GET /s/api/upload` is known. An unknown or legacy route must not show multi-page capture.
- Changing a crop rect or checkpoint must invalidate the earlier read and verification. A technical `succeeded` status is not content acceptance. Missing, uncertain, unchecked, or stale results must not reach confirmation, diagnosis, or printing.
- A correct answer on the same day is not mastery. Only a delayed rework counts. Parent and admin views stay aggregate: no question text and no reflections.
- Real AI mode must fail when its configuration is missing. Do not fall back to mock. Mock is only the local demo default.
- Docs must keep one way to run the app. Local student proof is `.claude/skills/verify-sel/`. Production is `src/main.ts` (`dist/main.js`). `npm run dev` is the old demo on `src/server.ts`, not the invitation student app.
- Do not hardcode a machine home path, and do not read `.env` from disk. Take keys from the environment and do not print them.
