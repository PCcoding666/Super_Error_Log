import { existsSync, readFileSync } from 'node:fs';
import { serverEnvExpect } from './launch.js';
import { assertSafeBase, readInstance } from './instance.js';
import { alive, commandLine } from './proc.js';
import { clientIndexPath, gitCommit, sha256File } from './paths.js';

export interface DoctorReport {
  ok: boolean;
  reasons: string[];
  notes: string[];
  base?: string;
  supervisorPid?: number;
  serverPid?: number;
  aiMode?: string;
  materialCapture?: boolean;
  commit?: string;
  startedCommit?: string;
  clientReady?: boolean;
  clientBuild?: 'same' | 'rebuilt-since-launch' | 'missing';
}

async function loginPage(base: string): Promise<{ status: number; body: string }> {
  const response = await fetch(new URL('/s/', base), { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
  const body = await response.text();
  return { status: response.status, body };
}

export async function doctor(): Promise<DoctorReport> {
  const reasons: string[] = [];
  const notes: string[] = [];
  const instance = readInstance();
  if (!instance) {
    return { ok: false, reasons: ['no instance. Run launch first. Do not drive a server this command did not start.'], notes };
  }
  const report: DoctorReport = {
    ok: false,
    reasons,
    notes,
    base: instance.base,
    supervisorPid: instance.supervisorPid,
    serverPid: instance.serverPid,
    aiMode: instance.aiMode,
    materialCapture: instance.materialCapture,
    startedCommit: instance.commit,
    commit: safeCommit(),
  };
  try { assertSafeBase(instance.base); }
  catch (error) { reasons.push(error instanceof Error ? error.message : String(error)); }
  if (instance.base.includes('pccoding666.com')) reasons.push('base URL points at production');
  if (!alive(instance.supervisorPid)) reasons.push(`supervisor ${instance.supervisorPid} is not running`);
  if (!alive(instance.serverPid)) reasons.push(`student host ${instance.serverPid} is not running`);
  const cmdline = commandLine(instance.serverPid);
  if (cmdline && !cmdline.includes('studentHostServer')) {
    reasons.push('the recorded server pid is not studentHostServer');
  }
  const envProblem = alive(instance.serverPid) ? serverEnvExpect(instance.serverPid) : null;
  if (envProblem) reasons.push(envProblem);
  if (report.commit && instance.commit !== report.commit) {
    reasons.push(`server started at ${instance.commit}, checkout is ${report.commit}. Cleanup and launch again before driving.`);
  }
  if (!existsSync(clientIndexPath)) {
    report.clientBuild = 'missing';
    reasons.push('dist/client/index.html is missing. Run npm run client:build.');
  } else {
    const hash = sha256File(clientIndexPath);
    report.clientBuild = hash === instance.clientIndexSha256 ? 'same' : 'rebuilt-since-launch';
    if (report.clientBuild === 'rebuilt-since-launch') {
      notes.push('dist/client changed since launch. The running server reads index.html per request, so the new client is what the browser gets. Server TypeScript does not reload.');
    }
  }
  if (reasons.length === 0) {
    try {
      const page = await loginPage(instance.base);
      report.clientReady = true;
      if (page.status !== 200) reasons.push(`GET /s/ returned ${page.status}, expected 200`);
      if (page.body.includes('还没有构建')) reasons.push('the server is serving the unbuilt client shell');
      if (!page.body.includes('data-testid="login-title"') || !page.body.includes('输入邀请码')) {
        reasons.push('GET /s/ without a cookie was not the invite login page');
      }
      const asset = existsSync(clientIndexPath) ? assetPath(readFileSync(clientIndexPath, 'utf8')) : null;
      if (!asset) reasons.push('dist/client/index.html has no /s/app/assets script');
      else {
        const assetResponse = await fetch(new URL(asset, instance.base), { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
        if (assetResponse.status !== 200) reasons.push(`client asset ${asset} returned ${assetResponse.status}`);
      }
    } catch (error) {
      reasons.push(`could not reach ${instance.base}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  report.ok = reasons.length === 0;
  return report;
}

function assetPath(html: string): string | null {
  const match = /\/s\/app\/assets\/[A-Za-z0-9._-]+\.js/.exec(html);
  return match ? match[0] : null;
}

function safeCommit(): string | undefined {
  try { return gitCommit(); } catch { return undefined; }
}
