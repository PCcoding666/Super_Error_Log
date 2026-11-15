# Super Error Log verification map

This directory is the maintained source for verifying the user-facing behavior of the current student app: invitation login, and the Ionic notebook served at `/s/`. Read this index before driving the app, then use the matching feature file as the recipe.

This is a feature map in the verification-skill sense: one file per user-facing feature, not a page-to-page flowchart. A proof that drives one convenient entry point is incomplete when the map lists others.

`sel-verify` in the feature files means this exact invocation, run from the repository root:

```sh
npx tsx .claude/skills/verify-sel/src/cli.ts
```

Copy every flag and quoted string after it unchanged. Do not reimplement the action with a new Playwright script.

## Baseline preconditions

- Launch with `sel-verify launch`. That starts `tests/e2e/studentHostServer.ts` on `127.0.0.1` with `SEL_AI_MODE=mock`, `NODE_ENV=test`, and `SEL_E2E_MATERIAL_CAPTURE=1`. Students, invite codes, and the registry live in a temp directory the fixture deletes on exit. Nothing here talks to production or reads `data/`.
- Run `sel-verify doctor` and require `ok: true` before the first drive, after a failed drive, and after any relaunch.
- The browser is one Playwright Chromium context: 390×844, iPhone Safari user agent, `zh-CN`, `Asia/Shanghai`, service workers blocked. `sel-verify drive` opens it. Do not point it at a server this launch did not start.
- A second `sel-verify launch` is refused while the first supervisor is alive. Two verification instances in one checkout would share the evidence log and the saved browser session.
- `npm run web:fake` (ports 3196/3197) is the legacy single-student pairing fixture. It forces legacy capture and does not use invitation login. Do not use it as proof of a feature in this map.
- The public help site `/help/` is not mounted on this fixture. Links from that site are a second, public entry on the full server. Report them as not driven here.
- A logged-in student has chosen a stage unless the recipe is [Choose stage](./choose-stage.md).
- Legacy server-rendered routes still respond (`/s/items`, `/s/photos`, `/s/practices`, `/s/capture`, `/s/practice/*`, `/s/settings`, …). They have no entry from the Ionic app. Do not open them as proof of a current feature. `/s/settings` is only relevant as the back target of My invite code, and that landing is not the current Settings page.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- `drive` commands share one browser page until `cleanup`. `drive open /s/` followed by `drive secret` fills the page the first command opened.
- Prefer the role, accessible name, or `data-testid` the command already names. Do not switch to a CSS selector or a screen coordinate.
- After a mutation, prove the result from a second user-facing view (reload, another entry point, or a later screen), not only from a toast.
- `sel-verify drive secret` is the only way to type an invite code. Do not print the code, put it in a command you might commit, or screenshot a field that still shows it.
- Restore seeded data after a mutation when a later step in the same session still needs it. Do not remove proof files during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state. `sel-verify drive shot` writes both a viewport screenshot and an ARIA snapshot, and appends the action to `artifacts/verify-sel/evidence/log.jsonl`.
- On screens that show it, the product name `超级错题本` or `错题本` should be in the shot. The notebook home does not show that word: its proof is the subject title plus the `N 道错题` subtitle.
- Record the feature id and the entry point on every shot (`--feature`, `--entry`).
- Report an unreachable path with the command you attempted and the unmet precondition. `sel-verify drive skip` writes that into the log. A skip is not a pass, and a different entry point does not cover it.

## Feature entry contract

Each feature file starts with an H1 and one paragraph of user-visible behavior, then exactly these four H2s, in order:

1. `Sub-features`
2. `How to get to it (user POV)`
3. `Driving it with sel-verify`
4. `Gotchas`

## Features

Sweep top to bottom. The learning loop is in the middle. Account recovery and install come after it.

- [Register](./register.md) covers first-time sign-up, saving the invite code, and entering the notebook.
- [Log in](./login.md) covers invite-code login, a prefilled link, a wrong code, and switching accounts on the same phone.
- [Recover invite code](./recover-invite.md) covers replacing a forgotten code with name, phone, and recovery PIN.
- [Choose stage](./choose-stage.md) covers the first-run 初中 / 高中 gate.
- [Notebook](./notebook.md) covers the empty and populated home, list and grid, search, filters, and removing a question.
- [Capture photos](./capture.md) covers camera and album entry, the 单页 / 多页 sheet, and the multi-page tray.
- [Intake](./intake.md) covers reviewing uploaded pages, keeping or dropping questions, and finishing the batch.
- [Question detail](./item-detail.md) covers the saved question: photo, text, traces, category, answer, remark, and remove.
- [Settings](./settings.md) covers stage, the practice placeholder, add to Home Screen, My invite code, and log out.
- [My invite code](./my-invite.md) covers viewing, copying, regenerating, and setting a recovery PIN.
- [Add to Home Screen](./add-to-home-screen.md) covers the install instructions opened from Settings.

`examples/learning-loop.json` drives the notebook, capture, intake, and question-detail entry points, including stem edit, category save, answer-photo upload, detail discard, and the Android blocked-chooser toast. `examples/account.json` drives register, prefilled login, account switch, recover, My invite code, install, and log out. Neither script replaces the other feature files.
