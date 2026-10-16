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
const students = [registry.createStudent().studentId, registry.createStudent('admin').studentId];
const codes = students.map(id => registry.issueInvitation(id).code);
const reloginCodes = students.map(id => registry.issueInvitation(id).code);
const pool = new StudentWorkerPool({ dirFor: id => registry.studentDir(id), env: { NODE_ENV: 'test', SEL_AI_MODE: 'mock', SEL_STUDENT_WORKER_FAKE: '1' } });
const gateway = await createStudentHostGateway({ registry, pool });
const app = express();
app.use('/s', gateway.router({ limiter: new RateLimiter(), ipOf: req => req.socket.remoteAddress ?? '127.0.0.1' }));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.send?.({ base, codes, reloginCodes });
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
