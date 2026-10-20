/** Browser fixture. Every account, token count and provider outcome here is synthetic. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { StudentRegistry } from '../../src/studentHost/registry.js';
import { AdminAuth } from '../../src/admin/auth.js';
import { createAdminRouter } from '../../src/admin/router.js';
import { recordAiUsage } from '../../src/observability/aiUsage.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-admin-browser-'));
const registry = StudentRegistry.open(root);
const auth = AdminAuth.open(root);
const password = auth.rotatePassword();
const accounts = ['小林（合成示例）', '小周（合成示例）'].map((name, index) => {
  const student = registry.createStudent();
  const db = new DatabaseSync(path.join(student.studentDir, 'app.db')); db.exec(SCHEMA_SQL);
  db.prepare('INSERT INTO student_profile(id, nickname, created_at) VALUES (?, ?, ?)').run(crypto.randomUUID(), name, '2026-10-18T04:00:00.000Z'); db.close();
  const first = registry.issueInvitation(student.studentId); registry.redeem(first.code); registry.issueInvitation(student.studentId);
  for (let i = 0; i < (index === 0 ? 51 : 3); i++) {
    const failed = i % 13 === 12;
    recordAiUsage({ id: crypto.randomUUID(), startedAt: new Date(Date.parse('2026-10-20T02:00:00.000Z') + i * 60000).toISOString(),
      operation: index ? 'asr' : 'mobile_transcribe', model: index ? 'synthetic-asr' : 'synthetic-vision', provider: 'synthetic', source: 'live',
      inputTokens: failed ? null : 800 + i * 10, outputTokens: failed ? null : 120 + i * 2, durationMs: failed ? 30000 : 1200 + i * 80,
      httpStatus: failed ? null : 200, status: failed ? 'failed' : 'succeeded', errorCode: failed ? 'timeout' : null }, student.studentDir);
  }
  return student.studentId;
});
const app = express();
app.use('/admin', createAdminRouter({ registry, auth, originScheme: 'http:', ipOf: request => request.socket.remoteAddress ?? 'unknown' }));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
process.send?.({ base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, password, accounts });
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  auth.close(); registry.close(); fs.rmSync(root, { recursive: true, force: true }); process.exit(0);
}
process.on('message', () => void stop()); process.on('disconnect', () => void stop()); process.on('SIGTERM', () => void stop());
