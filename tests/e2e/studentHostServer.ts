/** Forked E2E fixture: keep SSR JSX outside Playwright's test transformer. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { StudentRegistry } from '../../src/studentHost/registry.js';
import { StudentWorkerPool } from '../../src/studentHost/workers.js';
import { createStudentHostGateway } from '../../src/studentHost/router.js';
import { RateLimiter } from '../../src/mobile/rateLimit.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-invite-browser-'));
const registry = StudentRegistry.open(root);
const students = [registry.createStudent().studentId, registry.createStudent().studentId];
const codes = students.map(id => registry.issueInvitation(id).code);
// Third code reauthenticates A without deleting A's pending browser namespace.
codes.push(registry.issueInvitation(students[0]!).code);
const pool = new StudentWorkerPool({ dirFor: id => registry.studentDir(id), env: { NODE_ENV: 'test', SEL_AI_MODE: 'mock', SEL_STUDENT_WORKER_FAKE: '1', SEL_E2E_LEGACY_CAPTURE: process.env.SEL_E2E_MATERIAL_CAPTURE === '1' ? '0' : '1', SEL_E2E_MATERIAL_DELAY: process.env.SEL_E2E_MATERIAL_CAPTURE === '1' ? '1' : '0' } });
const gateway = await createStudentHostGateway({ registry, pool });
const app = express();
app.use('/s', gateway.router({ limiter: new RateLimiter(), ipOf: req => req.socket.remoteAddress ?? '127.0.0.1' }));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.send?.({ base, codes });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await gateway.close();
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(0);
}
process.on('message', () => void stop());
process.on('disconnect', () => void stop());
process.on('SIGTERM', () => void stop());
