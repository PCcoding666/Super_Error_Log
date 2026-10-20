/**
 * 学生 worker 的空闲退出、存活上限和跨学生信号量。用只做 IPC 的假 worker，不启动识别服务。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { StudentWorkerPool, WorkerStartError } from '../../src/studentHost/workers.js';

const roots: string[] = [];
const pools: StudentWorkerPool[] = [];
const workerScript = fileURLToPath(new URL('../helpers/capacityWorker.ts', import.meta.url));

afterEach(async () => {
  await Promise.all(pools.splice(0).map(pool => pool.stopAll()));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

function pool(options: { idleMs?: number; maxLiveWorkers?: number; aiConcurrency?: number; env?: NodeJS.ProcessEnv } = {}): StudentWorkerPool {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-capacity-'));
  roots.push(root);
  const created = new StudentWorkerPool({
    dirFor: studentId => path.join(root, studentId),
    workerScript,
    execArgv: ['--import', 'tsx'],
    refreshIntervalMs: 0,
    idleMs: options.idleMs ?? 0,
    maxLiveWorkers: options.maxLiveWorkers ?? 0,
    aiConcurrency: options.aiConcurrency ?? 2,
    imageConcurrency: 2,
    env: options.env,
  });
  pools.push(created);
  return created;
}

function childOf(target: StudentWorkerPool, studentId: string): ChildProcess {
  const entries = (target as unknown as { entries: Map<string, { child: ChildProcess }> }).entries;
  const child = entries.get(studentId)?.child;
  if (!child) throw new Error(`worker ${studentId} 不在`);
  return child;
}

function waitFor(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (check()) { resolve(); return; }
      if (Date.now() - start > timeoutMs) { reject(new Error('等待超时')); return; }
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe('lazy workers and the global AI permit', () => {
  it('exits an idle worker and keeps a busy one', async () => {
    const idle = pool({ idleMs: 400 });
    await idle.ensure('idle');
    expect(idle.isRunning('idle')).toBe(true);
    await waitFor(() => !idle.isRunning('idle'));

    const busy = pool({ idleMs: 300, env: { SEL_FAKE_BUSY: '1' } });
    await busy.ensure('busy');
    await new Promise(resolve => setTimeout(resolve, 900));
    expect(busy.isRunning('busy')).toBe(true);
    childOf(busy, 'busy').send({ type: 'set-busy', busy: false });
    await waitFor(() => !busy.isRunning('busy'), 8_000);
  });

  it('evicts the idle worker when the live cap is full, and refuses when everyone is busy', async () => {
    const capped = pool({ maxLiveWorkers: 1 });
    await capped.ensure('a');
    await capped.ensure('b');
    expect(capped.isRunning('a')).toBe(false);
    expect(capped.isRunning('b')).toBe(true);

    const full = pool({ maxLiveWorkers: 1 });
    full.retain('a');
    await full.ensure('a');
    await expect(full.ensure('b')).rejects.toMatchObject({ reason: 'capacity' });
    await expect(full.ensure('b')).rejects.toBeInstanceOf(WorkerStartError);
    expect(full.isRunning('a')).toBe(true);
    full.release('a');
  });

  it('queues a second vision permit until the first student releases it', async () => {
    const shared = pool({ aiConcurrency: 1 });
    await shared.ensure('a');
    await shared.ensure('b');
    const granted: string[] = [];
    for (const id of ['a', 'b']) {
      childOf(shared, id).on('message', (message: unknown) => {
        if ((message as { type?: string }).type === 'granted') granted.push(String((message as { id?: string }).id));
      });
    }
    childOf(shared, 'a').send({ type: 'please-acquire', kind: 'ai', id: 'a1' });
    await waitFor(() => granted.includes('a1'));
    childOf(shared, 'b').send({ type: 'please-acquire', kind: 'ai', id: 'b1' });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(granted).not.toContain('b1');
    childOf(shared, 'a').send({ type: 'please-release', kind: 'ai', id: 'a1' });
    await waitFor(() => granted.includes('b1'));
  });
});
