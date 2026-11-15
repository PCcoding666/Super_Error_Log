import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { instancePath, runDir } from './paths.js';

export interface VerifySlots {
  /** First synthetic student. Normal invitation login. */
  student: string;
  /** Second account, created with the admin role label. Still a normal login. */
  admin: string;
  /** Another live code for `student`. Does not log out other devices by itself. */
  studentExtra: string;
  /** Fresh code for `student`, from the fixture's relogin set. */
  relogin: string;
  /** Code that expires within 7 days. Settings shows 快到期. */
  expiring: string;
  /** Unused student's code. Use only for a prefilled `/s/?code=` link. */
  link: string;
}

export interface VerifyInstance {
  supervisorPid: number;
  serverPid: number;
  base: string;
  aiMode: 'mock';
  materialCapture: true;
  commit: string;
  clientIndexSha256: string;
  startedAt: string;
  slots: VerifySlots;
}

export interface ReadyMessage {
  base?: string;
  codes?: string[];
  reloginCodes?: string[];
  expiringCode?: string;
  linkCode?: string;
}

export function writeInstance(instance: VerifyInstance): void {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const tmp = `${instancePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(instance), { mode: 0o600 });
  renameSync(tmp, instancePath);
}

export function readInstance(): VerifyInstance | null {
  try {
    return JSON.parse(readFileSync(instancePath, 'utf8')) as VerifyInstance;
  } catch {
    return null;
  }
}

export function removeInstance(): void {
  rmSync(instancePath, { force: true });
}

/** Drop invite codes before anything is printed or written to evidence. */
export function publicInstance(instance: VerifyInstance): Record<string, unknown> {
  return {
    supervisorPid: instance.supervisorPid,
    serverPid: instance.serverPid,
    base: instance.base,
    aiMode: instance.aiMode,
    materialCapture: instance.materialCapture,
    commit: instance.commit,
    clientIndexSha256: instance.clientIndexSha256,
    startedAt: instance.startedAt,
    slots: Object.keys(instance.slots),
  };
}

export function slotValue(instance: VerifyInstance, slot: string): string {
  const value = instance.slots[slot as keyof VerifySlots];
  if (!value) {
    throw new Error(`unknown invite slot "${slot}". Known slots: ${Object.keys(instance.slots).join(', ')}`);
  }
  return value;
}

export function instanceFromReady(ready: ReadyMessage, meta: Omit<VerifyInstance, 'base' | 'slots' | 'aiMode' | 'materialCapture'>): VerifyInstance {
  const codes = ready.codes ?? [];
  const student = codes[0];
  const admin = codes[1];
  const studentExtra = codes[2];
  const relogin = ready.reloginCodes?.[0];
  if (!ready.base || !student || !admin || !studentExtra || !relogin || !ready.expiringCode || !ready.linkCode) {
    throw new Error('student host fixture did not return a base URL and synthetic invite slots');
  }
  let base: URL;
  try { base = new URL(ready.base); } catch { throw new Error('fixture returned a base URL that is not a URL'); }
  if (base.hostname !== '127.0.0.1') throw new Error(`fixture bound ${base.hostname}, expected 127.0.0.1`);
  return {
    ...meta,
    base: base.origin,
    aiMode: 'mock',
    materialCapture: true,
    slots: { student, admin, studentExtra, relogin, expiring: ready.expiringCode, link: ready.linkCode },
  };
}

export function assertSafeBase(base: string): URL {
  const url = new URL(base);
  if (url.hostname !== '127.0.0.1') throw new Error(`refusing to drive ${url.hostname}`);
  if (url.protocol !== 'http:') throw new Error(`refusing to drive ${url.protocol}`);
  return url;
}

export function runFile(name: string): string {
  return path.join(runDir, name);
}
