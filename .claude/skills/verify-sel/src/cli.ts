import path from 'node:path';
import { browse } from './browserHost.js';
import { driveOne, driveScript } from './browserClient.js';
import { cleanup, evidenceSummary } from './cleanup.js';
import { doctor } from './doctor.js';
import type { DriveOp } from './drive.js';
import { launch, supervise } from './launch.js';
import { auditFeatureDir } from './maintain.js';
import { featureDir, repoRoot } from './paths.js';

const HELP = `sel-verify — drive the local synthetic Super Error Log student app.

Run from the repository root:

  npx tsx .claude/skills/verify-sel/src/cli.ts <command>

Commands
  launch                         Start the invitation fixture (mock AI, synthetic students) and build the client if dist/client is missing.
  doctor                         Read-only check: our process, 127.0.0.1, mock AI, materials capture, client shell.
  drive <op> [flags]             One browser action on the persistent page. Runs doctor first.
  drive script --file <path>    Run a JSON array on that same page. Writes a trace.
  evidence                       List proof files. Does not delete them.
  cleanup                        Stop the server this launch started and delete session state. Keeps evidence.
  maintain                       Audit features/ against the source tree. Does not edit files and does not drive.

Drive ops
  open <path>                    page.goto, for example /s/ or /s/new
  open-slot --slot <slot>        Open /s/?code= for that slot. The code is not printed or logged.
  capture-code --testid <id> --slot <name>
                                 Remember the visible code under that name. The value is not printed.
  profile --name android|iphone Switch the device profile and keep the login.
  reset [--name android|iphone]  New page, same profile by default, cookies dropped.
  tap-file --testid <id>         Open that file input and choose nothing. Used for the Android blocked-chooser toast.
  click --testid <id>            or --role <role> --name <name>, or --text, or --label
  fill --text <value>            with the same target flags as click
  secret --slot <slot>           Fill an invite code from the instance file. The code is not printed.
                                 Slots: student, admin, studentExtra, relogin, expiring, link
  files --testid <id>            Attach a fresh synthetic JPEG to that control's file input.
  wait --testid <id>             or --heading <text>, or --url <path>, or --text <text>
       --state hidden            Wait until that test id is not visible.
       --timeout <ms>            Default 15000.
  shot --feature <id> --name <id> [--entry <id>] [--note <text>]
                                 Viewport screenshot plus an ARIA snapshot under artifacts/verify-sel/evidence/.
  swipe --testid <id>            Drag the row. If the option stays hidden, open ion-item-sliding the way the e2e suite does.
  text --testid <id>             Record the visible text in the evidence log.
  reload | back | url | press --key <key>
  skip --feature <id> --entry <id> --blocker <text>
                                 Record an entry point that was not driven, and why.

Shared click/fill flags: --exact, --nth <n>, --optional (record a skip instead of failing when missing or disabled).

Stdout is JSON. Invite codes are not included. Evidence stays after cleanup.
`;

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  process.exit(1);
}

interface Parsed {
  positional: string[];
  flag: Record<string, string | boolean>;
}

function parse(args: string[]): Parsed {
  const positional: string[] = [];
  const flag: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next === undefined || next.startsWith('--')) flag[key] = true;
    else { flag[key] = next; index += 1; }
  }
  return { positional, flag };
}

function text(flag: Record<string, string | boolean>, key: string): string | undefined {
  const value = flag[key];
  return typeof value === 'string' ? value : undefined;
}

function opFrom(subcommand: string, parsed: Parsed): DriveOp {
  const { flag, positional } = parsed;
  const op: DriveOp = {
    op: subcommand,
    path: positional[0],
    testid: text(flag, 'testid'),
    role: text(flag, 'role'),
    name: text(flag, 'name'),
    text: text(flag, 'text'),
    label: text(flag, 'label'),
    exact: flag.exact === true,
    nth: text(flag, 'nth') ? Number(text(flag, 'nth')) : undefined,
    timeout: text(flag, 'timeout') ? Number(text(flag, 'timeout')) : undefined,
    state: text(flag, 'state') === 'hidden' ? 'hidden' : undefined,
    feature: text(flag, 'feature'),
    note: text(flag, 'note'),
    entry: text(flag, 'entry'),
    slot: text(flag, 'slot'),
    key: text(flag, 'key') ?? (subcommand === 'press' ? positional[0] : undefined),
    optional: flag.optional === true,
    heading: text(flag, 'heading'),
    url: text(flag, 'url'),
    placeholder: text(flag, 'placeholder'),
    blocker: text(flag, 'blocker'),
  };
  return op;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (command === 'supervise') {
    await supervise();
    return;
  }
  if (command === 'browse') {
    await browse();
    return;
  }
  if (command === 'launch') {
    const started = await launch();
    process.stdout.write(`${JSON.stringify({ ok: true, ...started }, null, 2)}\n`);
    return;
  }
  if (command === 'doctor') {
    const report = await doctor();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exit(1);
    return;
  }
  if (command === 'cleanup') {
    const report = await cleanup();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exit(1);
    return;
  }
  if (command === 'evidence') {
    process.stdout.write(`${JSON.stringify({ ok: true, ...evidenceSummary() }, null, 2)}\n`);
    return;
  }
  if (command === 'maintain') {
    const report = auditFeatureDir(featureDir, [path.join(repoRoot, 'client', 'src'), path.join(repoRoot, 'src')]);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.outcome === 'blocked') process.exit(1);
    if (report.outcome === 'changed') process.exit(2);
    return;
  }
  if (command === 'drive') {
    const [subcommand, ...args] = rest;
    if (!subcommand) throw new Error('drive needs an op. Run with --help.');
    if (subcommand === 'script') {
      const parsed = parse(args);
      const file = text(parsed.flag, 'file');
      if (!file) throw new Error('drive script needs --file');
      const resolved = path.resolve(file);
      const result = await driveScript(resolved, text(parsed.flag, 'feature') ?? 'script');
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    const line = await driveOne(opFrom(subcommand, parse(args)));
    process.stdout.write(`${JSON.stringify(line, null, 2)}\n`);
    return;
  }
  throw new Error(`unknown command ${command}`);
}

main().catch(fail);
