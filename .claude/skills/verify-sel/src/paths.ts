import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Canonical skill directory. Cursor's copy is only a pointer. */
export const skillDir = path.resolve(here, '..');
/** Repository root: `.claude/skills/verify-sel/src` is four levels down. */
export const repoRoot = path.resolve(here, '../../../..');
export const runDir = path.join(repoRoot, 'artifacts', 'verify-sel');
export const evidenceDir = path.join(runDir, 'evidence');
export const sessionDir = path.join(runDir, 'session');
export const instancePath = path.join(runDir, 'instance.json');
export const serverLogPath = path.join(runDir, 'server.log');
export const launchErrorPath = path.join(runDir, 'launch-error.txt');
export const storageStatePath = path.join(sessionDir, 'storage.json');
export const clientIndexPath = path.join(repoRoot, 'dist', 'client', 'index.html');
export const featureDir = path.join(skillDir, 'features');
export const serverScript = path.join(repoRoot, 'tests', 'e2e', 'studentHostServer.ts');

export const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

export function gitCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

export function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function nodeMajor(): number {
  return Number(process.versions.node.split('.')[0] ?? 0);
}
