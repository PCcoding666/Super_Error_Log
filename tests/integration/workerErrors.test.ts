import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudentWorkerPool } from '../../src/studentHost/workers.js';

// 最小合成 worker：报 ready，把共享目录环境变量写到 stderr，收到 crash 就异常退出。
const WORKER = `
process.stderr.write('ledger=' + (process.env.SEL_AI_FALLBACK_LEDGER_DIR || '') + '\\n');
process.stderr.write('{"event":"sel_ai_fallback","level":"warn"}\\npartial-');
setTimeout(() => process.stderr.write('line-joined\\n'), 20);
process.on('message', message => {
  if (message && message.type === 'crash') { process.stderr.write('storage failure: synthetic\\n'); setTimeout(() => process.exit(3), 50); }
  if (message && message.type === 'query-busy') process.send({ type: 'busy', busy: false });
  if (message && message.type === 'stop') process.exit(0);
});
process.send({ type: 'ready', port: 1, token: 'synthetic-token' });
`;

const roots: string[] = [];
const pools: StudentWorkerPool[] = [];
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.stopAll();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) { if (Date.now() > until) throw new Error('timeout'); await new Promise(resolve => setTimeout(resolve, 25)); }
}

describe('worker errors reach journald (main process stderr)', () => {
  it('forwards worker stderr lines and reports unexpected exits as structured lines by default', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-worker-errors-')); roots.push(root);
    const script = path.join(root, 'worker.mjs'); fs.writeFileSync(script, WORKER);
    const written: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      return String(chunk).includes('worker ') || String(chunk).includes('sel_worker_error') ? true : (real as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write);
    const studentId = '0123abcd-0000-4000-8000-000000000000';
    const pool = new StudentWorkerPool({ dirFor: id => path.join(root, 'students', id), workerScript: script, execArgv: [], refreshIntervalMs: 0, idleMs: 0, sharedDir: root });
    pools.push(pool);
    await pool.ensure(studentId);
    await waitFor(() => written.some(line => line.includes('line-joined')));
    expect(written).toContain(`[worker 0123abcd] ledger=${root}\n`);
    expect(written).toContain('[worker 0123abcd] {"event":"sel_ai_fallback","level":"warn"}\n');
    expect(written).toContain('[worker 0123abcd] partial-line-joined\n');

    (pool as unknown as { entries: Map<string, { child: { send: (m: unknown) => void } }> }).entries.get(studentId)!.child.send({ type: 'crash' });
    await waitFor(() => written.some(line => line.includes('sel_worker_error')));
    const report = JSON.parse(written.find(line => line.includes('sel_worker_error'))!);
    expect(report).toMatchObject({ event: 'sel_worker_error', level: 'error', student: '0123abcd' });
    expect(report.message).toContain('code 3');
    expect(written).toContain('[worker 0123abcd] storage failure: synthetic\n');
    expect(written.join('')).not.toContain('synthetic-token');
  });

  it('a custom onError still takes precedence and onStderr: null keeps stderr private to the pool', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-worker-errors-')); roots.push(root);
    const script = path.join(root, 'worker.mjs'); fs.writeFileSync(script, WORKER);
    const errors: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write');
    const pool = new StudentWorkerPool({ dirFor: id => path.join(root, id), workerScript: script, execArgv: [], refreshIntervalMs: 0, idleMs: 0,
      onError: (_id, message) => { errors.push(message); }, onStderr: null });
    pools.push(pool);
    const studentId = 'feedbeef-0000-4000-8000-000000000000';
    await pool.ensure(studentId);
    (pool as unknown as { entries: Map<string, { child: { send: (m: unknown) => void } }> }).entries.get(studentId)!.child.send({ type: 'crash' });
    await waitFor(() => errors.length > 0);
    expect(errors[0]).toContain('code 3');
    expect(spy.mock.calls.map(call => String(call[0])).filter(line => line.includes('feedbeef'))).toEqual([]);
  });
});
