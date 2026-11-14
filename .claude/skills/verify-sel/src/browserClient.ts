import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { doctor } from './doctor.js';
import type { DriveOp } from './drive.js';
import { readInstance } from './instance.js';
import { alive } from './proc.js';
import { browserErrorPath, browserStatePath, repoRoot } from './paths.js';

interface BrowserState {
  pid: number;
  port: number;
  base: string;
}

const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));

function readState(): BrowserState | null {
  try { return JSON.parse(readFileSync(browserStatePath, 'utf8')) as BrowserState; } catch { return null; }
}

async function healthy(state: BrowserState, base: string): Promise<boolean> {
  if (!alive(state.pid) || state.base !== base) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/health`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return false;
    const body = await response.json() as { base?: string };
    return body.base === base;
  } catch {
    return false;
  }
}

async function stopPid(pid: number): Promise<void> {
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (!alive(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

/** Start the long-lived page, or reuse the one already attached to this server. */
export async function ensureBrowser(): Promise<BrowserState> {
  const report = await doctor();
  if (!report.ok) throw new Error(`doctor failed: ${report.reasons.join('; ')}`);
  const instance = readInstance();
  if (!instance) throw new Error('instance disappeared after doctor');
  const existing = readState();
  if (existing && await healthy(existing, instance.base)) return existing;
  if (existing && alive(existing.pid)) await stopPid(existing.pid);
  rmSync(browserStatePath, { force: true });
  rmSync(browserErrorPath, { force: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG ?? 'C.UTF-8',
  };
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const child = spawn(process.execPath, ['--import', 'tsx', cliPath, 'browse'], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();
  const pid = child.pid;
  if (!pid) throw new Error('browser host did not start');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!alive(pid)) {
      const error = existsSync(browserErrorPath) ? readFileSync(browserErrorPath, 'utf8').slice(-1500) : '';
      throw new Error(`browser host exited before it was ready. ${error}`.trim());
    }
    const state = readState();
    if (state && state.pid === pid && await healthy(state, instance.base)) return state;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  await stopPid(pid);
  throw new Error('timed out waiting for the browser host');
}

async function post(state: BrowserState, pathname: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${state.port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json() as { ok?: boolean; error?: string };
  if (!response.ok) throw new Error(payload.error ?? `browser host returned ${response.status}`);
  return payload;
}

export async function driveOne(op: DriveOp): Promise<unknown> {
  const state = await ensureBrowser();
  return post(state, '/run', { op, fallbackFeature: op.feature ?? 'drive' }, (op.timeout ?? 15_000) + 30_000);
}

export async function driveScript(file: string, fallbackFeature: string): Promise<unknown> {
  const ops = JSON.parse(readFileSync(file, 'utf8')) as DriveOp[];
  if (!Array.isArray(ops)) throw new Error('drive script must be a JSON array');
  const state = await ensureBrowser();
  return post(state, '/script', { ops, fallbackFeature }, 10 * 60_000);
}

export async function stopBrowser(): Promise<number | null> {
  const state = readState();
  if (!state) return null;
  if (alive(state.pid)) await stopPid(state.pid);
  rmSync(browserStatePath, { force: true });
  return state.pid;
}
