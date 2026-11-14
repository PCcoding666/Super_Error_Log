import { readFileSync } from 'node:fs';

/** Linux /proc helpers. Never print the raw environment. */
export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readEnviron(pid: number): Record<string, string> | null {
  try {
    const raw = readFileSync(`/proc/${pid}/environ`);
    const out: Record<string, string> = {};
    for (const entry of raw.toString('utf8').split('\0')) {
      if (!entry) continue;
      const eq = entry.indexOf('=');
      if (eq <= 0) continue;
      out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return out;
  } catch {
    return null;
  }
}

export function commandLine(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`).toString('utf8').replace(/\0/g, ' ').trim();
  } catch {
    return null;
  }
}
