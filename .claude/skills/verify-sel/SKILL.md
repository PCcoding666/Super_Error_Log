---
name: verify-sel
description: "Drive the Super Error Log student app on a local synthetic server (Ionic notebook at /s/, invitation login, mock AI) and capture proof. Use when a change touches student-facing UI, when asked to verify the app, or before claiming a student UI change works."
---

# Verify Super Error Log

Drive the current student app the way a student would, against a local synthetic server, and keep the screenshots. The feature map under `features/` is the source of truth for what to drive. A proof that uses one convenient entry point is incomplete when the map lists others.

This file is the canonical skill. `.cursor/skills/verify-sel/SKILL.md` only points here. Run every command from the repository root.

```sh
npx tsx .claude/skills/verify-sel/src/cli.ts <command>
```

The feature map writes that invocation as `sel-verify`. `npm run verify:sel -- <command>` is the same CLI. Stdout is JSON. Invite codes are not printed.

## Launch

```sh
npx tsx .claude/skills/verify-sel/src/cli.ts launch
```

Requires Node 24 or newer. If `dist/client/index.html` is missing, launch runs `npm run client:build` first. The server reads that file on every request.

Launch forks `tests/e2e/studentHostServer.ts` in a detached supervisor. The fixture listens on `127.0.0.1` and an ephemeral port, with `SEL_AI_MODE=mock`, `NODE_ENV=test`, and `SEL_E2E_MATERIAL_CAPTURE=1`. It creates synthetic students and invite codes in a temp directory. It does not read `data/`, `.env`, or production. A second launch is refused while the supervisor is alive.

Ready means the login page answers at `/s/`, not merely that a process exists. The command returns when the fixture has sent its ready message. The JSON names the invite slots (`student`, `admin`, `studentExtra`, `relogin`, `expiring`, `link`) and omits the codes.

`npm run web:fake` is a different server (legacy pairing, legacy capture). Do not launch it for this skill.

## Doctor

```sh
npx tsx .claude/skills/verify-sel/src/cli.ts doctor
```

Read-only. Exit 0 only when all of these hold:

- The supervisor and the student-host process from this launch are alive, and the host process is `studentHostServer`.
- Its environment is `SEL_AI_MODE=mock`, `NODE_ENV=test`, `SEL_E2E_MATERIAL_CAPTURE=1`, and it was not given `SEL_DATA_DIR`.
- The base URL is `http://127.0.0.1:<port>`.
- `HEAD` is the commit recorded at launch. Server TypeScript does not reload. Cleanup and launch again after a commit change.
- `GET /s/` without a cookie is the invite login page, not the unbuilt-client page.
- The client script named by `dist/client/index.html` is served by this process.

A rebuilt client is noted and still served, because the host reads `index.html` per request. Run doctor before the first drive and again after any drive that behaved unexpectedly. If doctor fails because the UI is wedged but the process is healthy, cleanup and launch rather than driving the wedged session.

## Drive

Doctor runs at the start of every drive. One `drive` command is one browser action. The first drive starts a browser host and leaves it running. Later commands, including a command in another process, continue on that same page: URL, form values, history, and open overlays stay. `cleanup` closes the host. `drive script --file <path>` runs a JSON array on that page and writes `artifacts/verify-sel/evidence/trace.zip`.

The browser is Playwright Chromium, headless, 390×844, iPhone Safari user agent, `zh-CN`, `Asia/Shanghai`, service workers blocked. On shutdown the host also writes cookies to `artifacts/verify-sel/session/`. A host that was killed without shutdown starts a new page; `open` again.

```sh
npx tsx .claude/skills/verify-sel/src/cli.ts drive open /s/
npx tsx .claude/skills/verify-sel/src/cli.ts drive secret --slot student --label "12 位邀请码"
npx tsx .claude/skills/verify-sel/src/cli.ts drive click --role button --name "进入我的错题本"
npx tsx .claude/skills/verify-sel/src/cli.ts drive wait --heading "你现在读初中还是高中？" --timeout 60000
npx tsx .claude/skills/verify-sel/src/cli.ts drive shot --feature choose-stage --name gate --entry server-page
```

Actions wait for an element, heading, URL, or text. A `wait` that names both a test id and text keeps waiting until that text is present or the timeout expires. They do not sleep. `drive files --testid <id>` attaches a generated JPEG. `drive secret` and `drive open-slot` read a code from the instance file and do not print it. `drive swipe` drags; if the row action stays hidden it opens `ion-item-sliding` the way `tests/e2e/intakeDelete.spec.ts` does, and the log says which happened.

A shot waits for finite CSS animations so an iOS page push is settled. Looping animations, such as a skeleton, do not block it. When several visible controls share a name, the last one in DOM order is used: that is the topmost Ionic sheet while an older sheet is still dismissing.

`drive script` stops on the first failing step after writing `artifacts/verify-sel/evidence/failure.png`. Fix the step and run again. Do not weaken a feature recipe to make the script pass.

The composed loops:

```sh
npx tsx .claude/skills/verify-sel/src/cli.ts drive script --file .claude/skills/verify-sel/examples/learning-loop.json --feature learning-loop
npx tsx .claude/skills/verify-sel/src/cli.ts drive script --file .claude/skills/verify-sel/examples/account.json --feature account
```

The learning loop covers notebook, capture, intake, and question detail, then switches to the Android shell for the blocked-chooser toast. The account script starts by dropping cookies and covers register, prefilled login, account switch, recover, My invite code, install, and log out. Neither script replaces the rest of the map.

## Evidence

Screenshots, ARIA snapshots, and `log.jsonl` go to `artifacts/verify-sel/evidence/`. A shot lands at `evidence/<feature>/<name>.png` plus `evidence/<feature>/<name>.aria.txt`. The log records the action and the URL with any `code` query removed.

```sh
npx tsx .claude/skills/verify-sel/src/cli.ts evidence
```

UI proof is the action plus the resulting screenshot and ARIA snapshot. Mutation proof reloads or opens a second screen and checks the saved value. List the feature and the entry point on the shot. A skipped entry is a `skip` line with the blocker, not a pass through a different path.

The evidence directory is gitignored. It can contain synthetic question text and, if you shot a code screen, a synthetic invite code. Do not commit it, and do not paste codes or code screenshots into a PR. Notebook, capture, intake, and question-detail shots from the learning loop are safe to attach.

## Cleanup

```sh
npx tsx .claude/skills/verify-sel/src/cli.ts cleanup
```

Sends SIGTERM to the supervisor this launch started. The fixture deletes its temp registry on the way out. Cleanup then deletes the session directory and the server log. It does not delete `artifacts/verify-sel/evidence/`. After cleanup, `evidence` still lists the files, and `doctor` reports that no instance is running.

Cleanup kills only the pids in the instance file. It does not kill by process name.

## Maintain

The map rots when the app changes. This pass does not edit product code. A behavior the map describes that the app no longer does is either drift in this skill (fix the map or the harness) or a product regression (report it, do not paper over it).

1. **Source audit.** `npx tsx .claude/skills/verify-sel/src/cli.ts maintain`

   Checks that every feature file has the four H2s in order, that `features/README.md` links the same set of files, that every `--testid` in the map occurs under `client/src` or `src`, and that a driving section does not open a leftover route. Exit 0 is `clean`, exit 2 is `changed` (findings, nothing edited), exit 1 is `blocked`. A testid that only exists on a leftover server page can still pass this audit. The live pass is what catches that.

2. **Reconcile.** Fix findings only inside `.claude/skills/verify-sel/`. If a testid is gone because the product removed it, update the map. If the control is still there for students and the harness cannot reach it, fix the harness. If the product behavior is actually broken, stop and report it.

3. **Live pass.** Launch, doctor, then drive every feature file at least once, including every entry point in "How to get to it". One long-lived server, serial drives. Doctor again after a failed drive. Record skips with the blocker. The learning-loop script covers notebook, capture, intake, and question detail; the other files still need their own pass.

4. **Stop.** Cleanup, then `evidence`, and confirm the proof files are still there. Outcome is one of:
   - `clean` — source audit clean, every feature driven or explicitly skipped with a blocker, no edit worth shipping.
   - `changed` — one PR of proven corrections inside this skill directory.
   - `blocked` — the pass could not finish, or a fix could not be proved. Name the blocker.

Do not commit the evidence log or the instance file.

## Helpers

| Command | What it does |
| --- | --- |
| `launch` | Build the client if needed, start the synthetic student host, write `artifacts/verify-sel/instance.json`. |
| `doctor` | Report whether that process is the one to drive. |
| `drive` | One action on the persistent page, or `drive script --file` on that same page. |
| `evidence` | List proof files. |
| `cleanup` | Stop the browser host and the server. Delete session state. Keep proof files. |
| `maintain` | Source audit of `features/`. |

`examples/learning-loop.json` is the worked script for the four learning-loop features. Viewport, user agent, and waits live in `src/drive.ts`. The server is the existing fixture `tests/e2e/studentHostServer.ts`, not a second implementation.
