import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DriveSession, type DriveOp } from './drive.js';
import { readInstance } from './instance.js';
import { browserErrorPath, browserStatePath, evidenceDir, runDir } from './paths.js';

interface BrowserState {
  pid: number;
  port: number;
  base: string;
}

/**
 * One Playwright page for the whole verification run.
 * Drive commands connect here and return. Closing this process is cleanup's job.
 */
export async function browse(): Promise<void> {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  mkdirSync(evidenceDir, { recursive: true });
  const instance = readInstance();
  if (!instance) {
    fail(new Error('no server instance. Run launch before drive.'));
    return;
  }
  let session: DriveSession;
  try {
    session = await DriveSession.open(instance);
  } catch (error) {
    fail(error);
    return;
  }
  let queue: Promise<void> = Promise.resolve();
  let tracing = false;
  const trace = path.join(evidenceDir, 'trace.zip');

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  const server = createServer((request, response) => {
    void enqueue(async () => {
      try {
        if (request.method === 'GET' && request.url === '/health') {
          send(response, 200, { ok: true, base: instance.base, url: safePath(session.page.url()) });
          return;
        }
        if (request.method !== 'POST') {
          send(response, 404, { ok: false, error: 'not found' });
          return;
        }
        const body = JSON.parse(await readBody(request)) as { op?: DriveOp; ops?: DriveOp[]; fallbackFeature?: string };
        if (request.url === '/run') {
          if (!body.op) throw new Error('missing op');
          const line = await session.run(body.op, body.fallbackFeature ?? body.op.feature ?? 'drive');
          send(response, 200, line);
          return;
        }
        if (request.url === '/script') {
          const ops = body.ops;
          if (!Array.isArray(ops)) throw new Error('drive script must be a JSON array');
          const feature = body.fallbackFeature ?? 'script';
          if (tracing) {
            await session.context.tracing.stop().catch(() => undefined);
            tracing = false;
          }
          await session.context.tracing.start({ screenshots: false, snapshots: true, sources: false });
          tracing = true;
          try {
            for (let index = 0; index < ops.length; index += 1) {
              const op = ops[index]!;
              try {
                await session.run(op, feature);
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                await session.failureShot(message, index, op);
                throw new Error(`step ${index} (${op.op}) failed: ${message}`);
              }
            }
          } finally {
            await session.context.tracing.stop({ path: trace }).catch(() => undefined);
            tracing = false;
          }
          send(response, 200, { ok: true, steps: ops.length, trace });
          return;
        }
        send(response, 404, { ok: false, error: 'not found' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!response.headersSent) send(response, 500, { ok: false, error: message });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    fail(new Error('browser host did not bind a port'));
    return;
  }
  const state: BrowserState = { pid: process.pid, port: address.port, base: instance.base };
  const tmp = `${browserStatePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, browserStatePath);

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    rmSync(browserStatePath, { force: true });
    server.close();
    await session.close().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

function fail(error: unknown): never {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  try { writeFileSync(browserErrorPath, message); } catch { /* ignore */ }
  process.exit(1);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error('drive request is too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function safePath(href: string): string {
  try {
    const url = new URL(href);
    url.searchParams.delete('code');
    return url.pathname + url.search + url.hash;
  } catch {
    return '';
  }
}
