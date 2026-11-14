import { spawn, fork, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { publicInstance, writeInstance, type ReadyMessage } from './instance.js';
import { alive, readEnviron } from './proc.js';
import {
  clientIndexPath, evidenceDir, gitCommit, instancePath, launchErrorPath, nodeMajor,
  repoRoot, runDir, serverLogPath, serverScript, sha256File,
} from './paths.js';

const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));

function cleanServerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG ?? 'C.UTF-8',
    NODE_ENV: 'test',
    SEL_AI_MODE: 'mock',
    SEL_E2E_MATERIAL_CAPTURE: '1',
  };
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
  return env;
}

async function ensureClient(): Promise<void> {
  if (existsSync(clientIndexPath)) return;
  const { spawnSync } = await import('node:child_process');
  const built = spawnSync('npm', ['run', 'client:build'], {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    timeout: 180_000,
  });
  if (built.status !== 0 || !existsSync(clientIndexPath)) {
    throw new Error(`client build failed.\n${(built.stdout ?? '').slice(-2000)}\n${(built.stderr ?? '').slice(-2000)}`);
  }
}

function requireNode24(): void {
  if (nodeMajor() < 24) {
    throw new Error(`Node ${process.versions.node} is too old. The student host uses node:sqlite and needs Node 24 or newer.`);
  }
}

/** Parent side: start a detached supervisor and wait until it writes instance.json. */
export async function launch(): Promise<Record<string, unknown>> {
  requireNode24();
  if (!existsSync(serverScript)) throw new Error(`missing fixture ${serverScript}`);
  const { readInstance } = await import('./instance.js');
  const existing = readInstance();
  if (existing && alive(existing.supervisorPid)) {
    throw new Error(`a verification server is already running (supervisor ${existing.supervisorPid}). Run cleanup before launch.`);
  }
  await ensureClient();
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(serverLogPath, '', { flag: 'w' });
  try { writeFileSync(launchErrorPath, ''); } catch { /* ignore */ }

  const supervisor = spawn(process.execPath, ['--import', 'tsx', cliPath, 'supervise'], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    env: { ...cleanServerEnv(), SEL_VERIFY_SUPERVISOR: '1' },
  });
  supervisor.unref();
  const supervisorPid = supervisor.pid;
  if (!supervisorPid) throw new Error('supervisor did not start');

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (!alive(supervisorPid)) {
      const error = existsSync(launchErrorPath) ? readFileSync(launchErrorPath, 'utf8').slice(-2000) : '';
      throw new Error(`supervisor exited before the server was ready. ${error}`.trim());
    }
    if (existsSync(instancePath)) {
      const instance = readInstance();
      if (instance && instance.supervisorPid === supervisorPid) return publicInstance(instance);
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  try { process.kill(-supervisorPid, 'SIGKILL'); } catch { /* already gone */ }
  const error = existsSync(launchErrorPath) ? readFileSync(launchErrorPath, 'utf8').slice(-2000) : '';
  throw new Error(`timed out waiting for the synthetic student host. ${error}`.trim());
}

/** Child side. Holds the fixture open until signaled. Not a user-facing command. */
export async function supervise(): Promise<void> {
  requireNode24();
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const log = (chunk: string): void => { try { appendFileSync(serverLogPath, chunk); } catch { /* ignore */ } };
  let server: ChildProcess | null = null;
  let stopping = false;
  const fail = (error: unknown): void => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    try { writeFileSync(launchErrorPath, message); } catch { /* ignore */ }
    log(`${message}\n`);
    if (server && !server.killed) server.kill('SIGKILL');
    process.exit(1);
  };
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    const child = server;
    if (!child || child.exitCode !== null) process.exit(0);
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    if (child.connected) {
      try { child.send({ stop: true }); } catch { child.kill('SIGTERM'); }
    } else child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 8_000);
    await exited;
    clearTimeout(killer);
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  try {
    server = fork(serverScript, [], {
      cwd: repoRoot,
      execArgv: ['--import', 'tsx'],
      env: cleanServerEnv(),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    server.stdout?.on('data', chunk => log(String(chunk)));
    server.stderr?.on('data', chunk => log(String(chunk)));
    const ready = await new Promise<ReadyMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture startup timeout')), 40_000);
      server!.once('error', error => { clearTimeout(timer); reject(error); });
      server!.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture exited (${code ?? 'signal'})`)); });
      server!.once('message', message => { clearTimeout(timer); resolve(message as ReadyMessage); });
    });
    if (!existsSync(clientIndexPath)) throw new Error('dist/client/index.html disappeared during launch');
    const { instanceFromReady } = await import('./instance.js');
    const instance = instanceFromReady(ready, {
      supervisorPid: process.pid,
      serverPid: server.pid ?? 0,
      commit: gitCommit(),
      clientIndexSha256: sha256File(clientIndexPath),
      startedAt: new Date().toISOString(),
    });
    writeInstance(instance);
    log(`ready ${instance.base} supervisor=${process.pid} server=${instance.serverPid}\n`);
    server.once('exit', code => {
      log(`fixture exited (${code ?? 'signal'})\n`);
      if (!stopping) fail(new Error(`fixture exited early (${code ?? 'signal'})`));
    });
  } catch (error) {
    fail(error);
  }
}

export function serverEnvExpect(pid: number): string | null {
  const env = readEnviron(pid);
  if (!env) return 'could not read the server process environment';
  if (env.SEL_AI_MODE !== 'mock') return `SEL_AI_MODE is ${env.SEL_AI_MODE ?? 'unset'}, expected mock`;
  if (env.NODE_ENV !== 'test') return `NODE_ENV is ${env.NODE_ENV ?? 'unset'}, expected test`;
  if (env.SEL_E2E_MATERIAL_CAPTURE !== '1') return 'SEL_E2E_MATERIAL_CAPTURE is not 1, so capture would be the legacy path';
  if (env.SEL_DATA_DIR) return 'server was given SEL_DATA_DIR; the verification fixture must use its own temp directory';
  return null;
}
