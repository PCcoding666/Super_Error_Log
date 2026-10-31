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

  it('does not hand a new request to a worker that is already exiting', async () => {
    const shared = pool({ idleMs: 150, env: { SEL_FAKE_STOP_DELAY_MS: '800' } });
    await shared.ensure('a');
    const first = childOf(shared, 'a');
    const stopping = new Promise<void>(resolve => {
      first.on('message', (message: unknown) => {
        if ((message as { type?: string }).type === 'stopping') resolve();
      });
    });
    await stopping;
    shared.retain('a');
    await shared.ensure('a');
    expect(childOf(shared, 'a').pid).not.toBe(first.pid);
    expect(shared.isRunning('a')).toBe(true);
    shared.release('a');
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

  it('ready 之前发出的名额申请也要受理；申请后启动失败的 worker 不留名额', async () => {
    // 2026-11-01 生产：学生 worker 启动即跑后台解答队列，在 send(ready) 之前向父进程借图片名额；
    // 父进程那时只挂了握手监听器，申请被静默丢掉，worker 永远等不到 permit → item_insight 永远为空、不调模型、worker 不空闲退出。
    const early = pool({ aiConcurrency: 1, env: { SEL_FAKE_ACQUIRE_BEFORE_READY: 'early' } });
    await early.ensure('a');
    const seen: string[] = [];
    childOf(early, 'a').on('message', (message: unknown) => {
      if ((message as { type?: string }).type === 'granted-list') seen.push(...((message as { ids?: string[] }).ids ?? []));
    });
    const ask = (): void => { childOf(early, 'a').send({ type: 'please-list-granted' }); };
    ask();
    await waitFor(() => { if (!seen.includes('early')) ask(); return seen.includes('early'); }, 3_000);
    expect(early.capacitySnapshot().aiInUse).toBe(1);
    childOf(early, 'a').send({ type: 'please-release', kind: 'ai', id: 'early' });
    await waitFor(() => early.capacitySnapshot().aiInUse === 0, 3_000);

    // 申请到名额后启动失败（进程退出）：名额随进程归还，不堵住别的学生。
    const dying = pool({ aiConcurrency: 1, env: { SEL_FAKE_ACQUIRE_BEFORE_READY: 'doomed', SEL_FAKE_DIE_AFTER_ACQUIRE: '1' } });
    await expect(dying.ensure('a')).rejects.toBeInstanceOf(WorkerStartError);
    await waitFor(() => dying.capacitySnapshot().aiInUse === 0, 3_000);
    expect(dying.capacitySnapshot().aiWaiting).toBe(0);
  });
});
