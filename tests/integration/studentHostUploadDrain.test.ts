/**
 * 回归：上游（学生 worker）在读完上传正文之前就回了响应并断开连接时，网关必须把客户端还在上行的
 * 正文读空（drain），让这条 HTTP/1.1 请求正常收尾。否则 Caddy 侧看到的是连接被重置，会把 worker
 * 已经给出的 429/503 变成 502，手机上显示「网络没连上」（见 2026-10-24 生产 Caddy 日志）。
 *
 * 用一个假进程池把网关指到一个「立刻回 429 再掐断 socket、从不读正文」的假 worker 上，复现这一幕：
 * - 修复前：客户端那路大正文卡住，连接被重置。
 * - 修复后：网关把剩余正文读空，客户端拿到完整的 429 JSON。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { StudentRegistry } from '../../src/studentHost/registry.js';
import { createStudentHostGateway, SESSION_COOKIE, type StudentHostGateway } from '../../src/studentHost/router.js';
import type { StudentWorkerPool } from '../../src/studentHost/workers.js';
import { RateLimiter } from '../../src/mobile/rateLimit.js';

const roots: string[] = [];
const gateways: StudentHostGateway[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

interface Outcome { status: number | null; body: string; error: string | null; written: number; closed: boolean; writeError: string | null }

/** 像 Caddy 一样慢写正文、收到响应后仍写完，记录响应 / 写错误 / 连接是否被对端重置。 */
function trickle(base: string, cookie: string, body: Buffer, chunkBytes: number, intervalMs: number): Promise<Outcome> {
  const url = new URL(base);
  return new Promise(resolve => {
    let written = 0; let status: number | null = null; let text = ''; let closed = false; let writeError: string | null = null;
    let responseDone = false; let bodyDone = false; let error: string | null = null; let resolved = false;
    const maybe = (): void => { if (resolved) return; if ((responseDone || error) && (bodyDone || error || closed)) { resolved = true; resolve({ status, body: text, error, written, closed, writeError }); } };
    const request = http.request({ host: url.hostname, port: url.port, method: 'POST', path: '/s/materials/uploads',
      headers: { cookie, origin: base, accept: 'application/json', 'content-type': 'application/octet-stream', 'content-length': String(body.length), 'user-agent': 'trickle-test' },
    }, response => {
      status = response.statusCode ?? 0; response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => { responseDone = true; maybe(); });
      response.on('error', e => { error = `response:${(e as NodeJS.ErrnoException).code ?? e.message}`; maybe(); });
    });
    request.on('error', e => { error = `request:${(e as NodeJS.ErrnoException).code ?? e.message}`; maybe(); });
    request.on('socket', socket => socket.on('close', () => { closed = true; maybe(); }));
    request.setTimeout(30_000, () => request.destroy(new Error('timeout')));
    let offset = 0;
    const pump = (): void => {
      if (resolved || error || closed) return;
      if (offset >= body.length) { request.end(() => { bodyDone = true; maybe(); }); return; }
      const next = body.subarray(offset, offset + chunkBytes); offset += next.length;
      request.write(next, e => { if (e) { writeError = (e as NodeJS.ErrnoException).code ?? e.message; return; } written += next.length; });
      setTimeout(pump, intervalMs);
    };
    pump();
  });
}

/** 立刻回 429、从不读正文、随后掐断 socket 的假 worker（复现 worker 早退 + 连接提前关闭）。 */
function earlyRejectUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.statusCode = 429;
    res.setHeader('content-type', 'application/json');
    res.setHeader('retry-after', '1');
    res.end(JSON.stringify({ error: { code: 'busy', message: '服务器正在处理另一个上传，请稍后再试。' } }));
    // Tear the upstream socket down before the inbound body drained — the shape the gateway must survive.
    setTimeout(() => { try { req.socket.destroy(); } catch { /* already gone */ } }, 100);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>(r => server.close(() => r())),
  })));
}

describe('上游早退并掐断连接时，网关把上传正文读空', () => {
  it('客户端拿到完整的 429，而不是连接被重置', async () => {
    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-host-drain-'));
    roots.push(hostDir);
    const registry = StudentRegistry.open(hostDir);
    const upstream = await earlyRejectUpstream();

    // 假进程池：网关把所有转发指到上面的假 worker，不 fork 真进程。
    const fakePool = {
      retain() {}, release() {}, capacitySnapshot() { return { live: 1, maxLive: 1, aiLimit: 1, aiInUse: 0, aiWaiting: 0, aiAverageMs: null }; },
      ensure() { return Promise.resolve({ port: upstream.port, token: 'test-token' }); },
      stopAll() { return Promise.resolve(); },
    } as unknown as StudentWorkerPool;

    const gateway = await createStudentHostGateway({ hostDir, registry, pool: fakePool });
    gateways.push(gateway);
    const app = express(); app.disable('x-powered-by');
    app.use('/s', gateway.router({ limiter: new RateLimiter(), ipOf: request => request.socket.remoteAddress ?? 'unknown' }));
    const server = app.listen(0, '127.0.0.1'); servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const { studentId } = registry.createStudent();
    const { code } = registry.issueInvitation(studentId);
    const cookies = new Map<string, string>();
    const loginBody = new URLSearchParams({ code });
    const login = await fetch(`${base}/s/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, 'user-agent': 'iPhone' }, body: loginBody });
    for (const line of login.headers.getSetCookie()) { const [p] = line.split(';'); const i = p!.indexOf('='); cookies.set(p!.slice(0, i), p!.slice(i + 1)); }
    expect(cookies.has(SESSION_COOKIE)).toBe(true);
    const cookieHeader = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');

    // 1 MB 正文，按 32 KB / 40 ms 慢写（约 1.3 s 传完），模拟手机上行。
    const bodyBuf = crypto.randomBytes(1024 * 1024);
    const outcome = await trickle(base, cookieHeader, bodyBuf, 32 * 1024, 40);
    console.log('outcome', JSON.stringify({ ...outcome, body: outcome.body.slice(0, 160) }));
    await upstream.close();

    expect(outcome.error).toBeNull();
    expect(outcome.writeError).toBeNull();
    expect(outcome.status).toBe(429);
    expect(JSON.parse(outcome.body)).toMatchObject({ error: { code: 'busy' } });
  }, 60_000);
});
