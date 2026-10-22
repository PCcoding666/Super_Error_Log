/**
 * P0-7 界面部分：worker 名额满时，网关的 503 说真话（名额、AI 排队、其他在等的人数）并自动重试。
 * 只做 IPC 的假 worker（tests/helpers/capacityWorker.ts），合成学生，不调任何模型。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterEach, expect, it } from 'vitest';
import { StudentRegistry } from '../../src/studentHost/registry.js';
import { createStudentHostGateway, SESSION_COOKIE, type StudentHostGateway } from '../../src/studentHost/router.js';
import { StudentWorkerPool } from '../../src/studentHost/workers.js';
import { RateLimiter } from '../../src/mobile/rateLimit.js';

const roots: string[] = []; const gateways: StudentHostGateway[] = []; const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map(g => g.close()));
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve()))));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});
const workerScript = fileURLToPath(new URL('../helpers/capacityWorker.ts', import.meta.url));

async function login(base: string, code: string): Promise<string> {
  const response = await fetch(`${base}/s/login`, { method: 'POST', redirect: 'manual', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code }) });
  const line = response.headers.getSetCookie().find(l => l.startsWith(`${SESSION_COOKIE}=`))!;
  return line.split(';')[0]!;
}

it('a full host answers with honest facts, Retry-After and a self-retrying page', async () => {
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-busy-')); roots.push(hostDir);
  const registry = StudentRegistry.open(hostDir);
  const pool = new StudentWorkerPool({ dirFor: id => registry.studentDir(id), workerScript, execArgv: ['--import', 'tsx'], refreshIntervalMs: 0, idleMs: 0, maxLiveWorkers: 1, aiConcurrency: 1, imageConcurrency: 1, env: { SEL_FAKE_BUSY: '1' } });
  const gateway = await createStudentHostGateway({ hostDir, registry, pool }); gateways.push(gateway);
  const app = express(); app.use('/s', gateway.router({ limiter: new RateLimiter(), ipOf: () => '127.0.0.1' }));
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const [a, b, c] = [0, 1, 2].map(() => registry.createStudent().studentId);
  // A holds the only live slot with background work and one AI call in progress.
  await pool.ensure(a!);
  const child = (pool as unknown as { entries: Map<string, { child: ChildProcess }> }).entries.get(a!)!.child;
  child.send({ type: 'please-acquire', kind: 'ai', id: 'synthetic-ai-1' });
  await expect.poll(() => pool.capacitySnapshot().aiInUse).toBe(1);

  const cookieB = await login(base, registry.issueInvitation(b!).code);
  const cookieC = await login(base, registry.issueInvitation(c!).code);
  const first = await fetch(`${base}/s/items`, { headers: { cookie: cookieB } });
  expect(first.status).toBe(503);
  expect(first.headers.get('retry-after')).toBe('30');
  const html = await first.text();
  expect(html).toContain('人有点多');
  expect(html).toContain('<meta http-equiv="refresh" content="30"/>');
  expect(html).toContain('href="/s/items"');
  expect(html).toContain('最多同时开 1 个同学的错题本，1 个都在用');
  expect(html).toContain('正在做 1 件，还有 0 件在排队');
  expect(html).not.toContain('一两分钟再试');
  expect(html).not.toContain('位同学也在等');

  const second = await fetch(`${base}/s/`, { headers: { cookie: cookieC } });
  expect(second.status).toBe(503);
  expect(await second.text()).toContain('除了你，还有 1 位同学也在等');

  const json = await fetch(`${base}/s/materials/session`, { headers: { cookie: cookieC, accept: 'application/json' } });
  expect(json.status).toBe(503);
  expect(json.headers.get('retry-after')).toBe('30');
  expect(await json.json()).toMatchObject({ error: { code: 'capacity', message: expect.stringContaining('1 个都在用') } });
}, 60_000);
