/** Forked E2E fixture: keep SSR JSX outside Playwright's test transformer. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { pathToFileURL } from 'node:url';
import { StudentRegistry } from '../../src/studentHost/registry.js';
import { StudentWorkerPool } from '../../src/studentHost/workers.js';
import { createStudentHostGateway } from '../../src/studentHost/router.js';
import { RateLimiter } from '../../src/mobile/rateLimit.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-invite-browser-'));
const registry = StudentRegistry.open(root);
const students = [registry.createStudent().studentId, registry.createStudent('admin').studentId];
const codes = students.map(id => registry.issueInvitation(id).code);
const reloginCodes = students.map(id => registry.issueInvitation(id).code);
// Third code reauthenticates A without deleting A's pending browser namespace.
codes.push(registry.issueInvitation(students[0]!).code);
// 另有一个邀请码 3 天后到期的合成学生，用来看设置页提醒。
const expiringStudent = registry.createStudent().studentId;
const expiringCode = registry.issueInvitation(expiringStudent).code;
{
  const db = new DatabaseSync(path.join(root, 'registry.db'));
  db.prepare('UPDATE invitations SET expires_at = ? WHERE student_id = ?').run(new Date(Date.now() + 3 * 86_400_000 - 60_000).toISOString(), expiringStudent);
  db.close();
}
const control = path.join(root, 'material-control.json');
fs.writeFileSync(control, process.env.SEL_E2E_MATERIAL_CONFIG ?? '{}');
const fixtureEnv = process.env.SEL_E2E_MATERIAL_JOURNEY === '1' ? { SEL_E2E_MATERIAL_FIXTURE: pathToFileURL(path.resolve('tests/e2e/materialFixture.ts')).href, SEL_E2E_MATERIAL_CONTROL: control } : {};
const pool = new StudentWorkerPool({ dirFor: id => registry.studentDir(id), env: { ...fixtureEnv, NODE_ENV: 'test', SEL_AI_MODE: 'mock', SEL_STUDENT_WORKER_FAKE: '1', SEL_E2E_LEGACY_CAPTURE: process.env.SEL_E2E_MATERIAL_CAPTURE === '1' ? '0' : '1', SEL_E2E_MATERIAL_DELAY: process.env.SEL_E2E_MATERIAL_CAPTURE === '1' ? '1' : '0' } });
const gateway = await createStudentHostGateway({ registry, pool, requireRegistrationCode: false });
const app = express();
app.use('/s', gateway.router({ limiter: new RateLimiter(), ipOf: req => req.socket.remoteAddress ?? '127.0.0.1' }));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.send?.({ base, codes, reloginCodes, expiringCode });
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
process.on('message', async (message: { id?: string; action?: string; student?: number; config?: unknown }) => {
  if (!message.action) { void stop(); return; }
  try {
    if (message.action === 'configure') fs.writeFileSync(control, JSON.stringify(message.config));
    const file = path.join(registry.studentDir(students[message.student ?? 0]!), 'app.db');
    let result: unknown = null;
    if (message.action === 'legacy') {
      // Seed a genuine historical mobile upload through its authenticated APIs, not direct table inserts.
      const endpoint=await pool.ensure(students[message.student ?? 0]!);
      const headers={authorization:`Bearer ${endpoint.token}`};
      const uploaded=await fetch(`http://127.0.0.1:${endpoint.port}/v1/recognitions`,{method:'POST',headers:{...headers,'content-type':'image/jpeg','idempotency-key':crypto.randomUUID()},body:new Uint8Array(await sharp({create:{width:240,height:320,channels:3,background:'#fff'}}).jpeg().toBuffer())});
      if(uploaded.status!==202)throw Error('Synthetic legacy upload failed');
      const body=await uploaded.json() as {job:{jobId?:string;id:string}};const id=body.job.id??body.job.jobId!;
      const registered=await fetch(`http://127.0.0.1:${endpoint.port}/v2/photos/${id}/register`,{method:'POST',headers});
      if(!registered.ok)throw Error('Synthetic legacy registration failed');
      // Queue admission is not completion: the page does not poll an empty pick
      // list. Wait for this synthetic legacy inventory before returning its URL.
      const deadline=Date.now()+8000;
      while(true){
        const status=await fetch(`http://127.0.0.1:${endpoint.port}/v1/recognitions/${id}`,{headers});
        if(!status.ok)throw Error('Synthetic legacy status failed');
        const current=await status.json() as {job:{status:string}};
        if(current.job.status==='completed')break;
        if(['failed','partial'].includes(current.job.status)||Date.now()>=deadline)throw Error('Synthetic legacy recognition did not complete');
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      result={jobId:id};
    }
    if (message.action === 'snapshot' || message.action === 'age') {
      const db = new DatabaseSync(file, { timeout: 5000 }); // wait for the worker's write lock instead of failing at once
      if (message.action === 'age') {
        db.exec("UPDATE review_packet SET generated_at=datetime('now','-7 days'); UPDATE error_item SET created_at=datetime('now','-7 days'); UPDATE material_asset SET created_at=datetime('now','-1 day'); UPDATE material_capture SET created_at=datetime('now','-1 day')");
      } else {
        result = Object.fromEntries(['material_capture','material_document','material_answer_selection','material_question','material_asset','material_fragment','material_attempt','material_answer','material_grade','material_job','material_link_event','error_item','review_packet','review_attempt','v2_reflection_turn'].map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));
      }
      db.close();
    }
    process.send?.({ id: message.id, result });
  } catch(error) { process.send?.({ id: message.id, error: String(error) }); }
});
process.on('disconnect', () => void stop());
process.on('SIGTERM', () => void stop());
