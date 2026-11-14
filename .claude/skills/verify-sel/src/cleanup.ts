import { readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { stopBrowser } from './browserClient.js';
import { removeInstance, readInstance } from './instance.js';
import { alive } from './proc.js';
import { browserErrorPath, evidenceDir, launchErrorPath, runDir, serverLogPath, sessionDir } from './paths.js';

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(pid, signal); } catch { /* already gone */ }
}

async function waitDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return !alive(pid);
}

export interface CleanupReport {
  ok: boolean;
  stopped: number[];
  evidenceFiles: number;
  evidenceDir: string;
}

function countFiles(dir: string): number {
  if (!statExists(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) count += countFiles(full);
    else count += 1;
  }
  return count;
}

function statExists(dir: string): boolean {
  try { return statSync(dir).isDirectory(); } catch { return false; }
}

/**
 * Stop the supervisor and student host this run started, and delete session state.
 * Evidence files stay where they are.
 */
export async function cleanup(): Promise<CleanupReport> {
  const browserPid = await stopBrowser();
  const instance = readInstance();
  const stopped: number[] = [];
  if (browserPid) stopped.push(browserPid);
  const pids = [instance?.supervisorPid, instance?.serverPid].filter((pid): pid is number => typeof pid === 'number');
  if (instance && alive(instance.supervisorPid)) signalPid(instance.supervisorPid, 'SIGTERM');
  if (instance && !(await waitDead(instance.supervisorPid, 8_000))) signalPid(instance.supervisorPid, 'SIGKILL');
  if (instance && alive(instance.serverPid)) signalPid(instance.serverPid, 'SIGTERM');
  for (const pid of pids) {
    if (!alive(pid)) { stopped.push(pid); continue; }
    const gone = await waitDead(pid, 3_000);
    if (!gone) signalPid(pid, 'SIGKILL');
    await waitDead(pid, 2_000);
    if (!alive(pid)) stopped.push(pid);
  }
  removeInstance();
  rmSync(sessionDir, { recursive: true, force: true });
  rmSync(serverLogPath, { force: true });
  rmSync(launchErrorPath, { force: true });
  rmSync(browserErrorPath, { force: true });
  const still = [...pids, ...(browserPid ? [browserPid] : [])].filter(pid => alive(pid));
  return {
    ok: still.length === 0,
    stopped,
    evidenceFiles: countFiles(evidenceDir),
    evidenceDir,
  };
}

export function evidenceSummary(): { evidenceDir: string; files: string[]; count: number } {
  const files: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    if (!statExists(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else files.push(rel);
    }
  };
  walk(evidenceDir, '');
  files.sort();
  return { evidenceDir, files, count: files.length };
}

export function runDirPath(): string {
  return runDir;
}
