/**
 * Local student gateway for help-page screenshots.
 * Registration is open. Extraction is the real-paper replay in help-real-fixture.ts.
 * The process is mock-mode only so the worker will load that fixture; the visible
 * stems, photos, chapters and answers come from the two historical pages.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { StudentRegistry } from '../src/studentHost/registry.js';
import { StudentWorkerPool } from '../src/studentHost/workers.js';
import { createStudentHostGateway } from '../src/studentHost/router.js';
import { resolvePublicOrigin } from '../src/studentHost/inviteLink.js';
import { RateLimiter } from '../src/mobile/rateLimit.js';
import { writeHelpAnswers } from './help-real-papers.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-help-real-'));
const answers = path.join(root, 'help-answers.json');
writeHelpAnswers(answers);
const registry = StudentRegistry.open(root);
const pool = new StudentWorkerPool({
  dirFor: id => registry.studentDir(id),
  env: {
    NODE_ENV: 'test',
    SEL_AI_MODE: 'mock',
    SEL_STUDENT_WORKER_FAKE: '1',
    SEL_E2E_LEGACY_CAPTURE: '0',
    SEL_E2E_MATERIAL_FIXTURE: pathToFileURL(path.resolve('scripts/help-real-fixture.ts')).href,
    SEL_HELP_REAL_ANSWERS: answers,
    SEL_INSIGHT_QUEUE_INTERVAL_MS: '500',
    // The capture worker decodes full exam photos. The default 256 MiB pause is for production admission, not this local replay.
    SEL_RSS_ADMISSION_MIB: '4096',
  },
});
const gateway = await createStudentHostGateway({ registry, pool, requireRegistrationCode: false });
const app = express();
const linkOrigin = process.env.SEL_HELP_CAPTURE_ORIGIN?.trim()
  ? resolvePublicOrigin(process.env, process.env.SEL_HELP_CAPTURE_ORIGIN)
  : undefined;
app.use('/s', gateway.router({ limiter: new RateLimiter(), ipOf: req => req.socket.remoteAddress ?? '127.0.0.1', linkOrigin }));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.send?.({ base });

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await gateway.close();
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(0);
}
process.on('message', () => { void stop(); });
process.on('disconnect', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
