/**
 * #127：学生端的指纹资源按 Accept-Encoding 发构建时的预压缩件（.br / .gz）。
 * 用真实构建产物 dist/client（CI 和 `npm run verify` 都先 build 再 test）。
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptedEncodings, clientAppDir, sendClientAsset } from '../../src/web/clientApp.js';

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

let server: http.Server;
let port = 0;
let assets = '';
let script = '';
let style = '';

beforeAll(async () => {
  const dir = clientAppDir();
  expect(dir, '没有 dist/client：先运行 npm run build').not.toBeNull();
  assets = path.join(dir!, 'assets');
  const shell = fs.readFileSync(path.join(dir!, 'index.html'), 'utf8');
  script = /\/s\/app\/assets\/(index-[\w-]+\.js)/.exec(shell)![1]!;
  style = /\/s\/app\/assets\/(index-[\w-]+\.css)/.exec(shell)![1]!;
  const app = express();
  app.get('/s/app/assets/:file', sendClientAsset);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

/** 不用 fetch：它会自动解压，看不到实际传了多少字节。 */
function get(name: string, acceptEncoding?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: `/s/app/assets/${name}`, headers: acceptEncoding === undefined ? {} : { 'accept-encoding': acceptEncoding } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk as Buffer));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end();
  });
}

describe('学生端资源的预压缩件', () => {
  it('构建给主脚本和样式都生成了 .br 和 .gz，直接请求压缩件仍是 404', async () => {
    for (const name of [script, style]) for (const suffix of ['.br', '.gz']) {
      expect(fs.existsSync(path.join(assets, name + suffix)), name + suffix).toBe(true);
      expect((await get(name + suffix, 'br, gzip')).status, name + suffix).toBe(404);
    }
  });

  it('浏览器接受 br 时发 br：体积在 400 KB 以内，解开和原文件一字不差，缓存头不变', async () => {
    const original = fs.readFileSync(path.join(assets, script));
    const reply = await get(script, 'gzip, deflate, br, zstd');
    expect(reply.status).toBe(200);
    expect(reply.headers['content-encoding']).toBe('br');
    expect(String(reply.headers.vary).toLowerCase()).toContain('accept-encoding');
    expect(reply.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(reply.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(Number(reply.headers['content-length'])).toBe(reply.body.length);
    expect(reply.body.length).toBeLessThan(400 * 1024);
    expect(reply.body.length).toBeLessThan(original.length / 3);
    expect(brotliDecompressSync(reply.body).equals(original)).toBe(true);
  });

  it('只接受 gzip 时发 gzip，样式表也一样', async () => {
    for (const name of [script, style]) {
      const original = fs.readFileSync(path.join(assets, name));
      const reply = await get(name, 'gzip');
      expect(reply.headers['content-encoding'], name).toBe('gzip');
      expect(reply.body.length, name).toBeLessThan(original.length);
      expect(gunzipSync(reply.body).equals(original), name).toBe(true);
    }
    expect((await get(script, 'br;q=0, gzip;q=0.5')).headers['content-encoding']).toBe('gzip');
  });

  it('不带请求头、只要原样、把两种都拒掉、只写 * 时，发原文件，但仍带 Vary', async () => {
    const original = fs.readFileSync(path.join(assets, script));
    for (const header of [undefined, 'identity', 'br;q=0, gzip;q=0', '*', 'deflate']) {
      const reply = await get(script, header);
      expect(reply.status, String(header)).toBe(200);
      expect(reply.headers['content-encoding'], String(header)).toBeUndefined();
      expect(String(reply.headers.vary).toLowerCase(), String(header)).toContain('accept-encoding');
      expect(reply.body.equals(original), String(header)).toBe(true);
    }
  });

  it('没有压缩件的小文件照发原文件', async () => {
    const small = fs.readdirSync(assets).find(name => name.endsWith('.js') && !fs.existsSync(path.join(assets, `${name}.br`)));
    if (!small) return; // 这次构建没有小于 1 KB 的脚本
    const reply = await get(small, 'br, gzip');
    expect(reply.status).toBe(200);
    expect(reply.headers['content-encoding']).toBeUndefined();
    expect(reply.body.equals(fs.readFileSync(path.join(assets, small)))).toBe(true);
  });

  it('不存在的文件和带路径的名字仍是 404', async () => {
    expect((await get('nope-12345678.js', 'br')).status).toBe(404);
    expect((await get('..%2Findex.html', 'br')).status).toBe(404);
  });
});

describe('acceptedEncodings', () => {
  it('只收点名且 q 不为 0 的编码，大小写和空格不影响', () => {
    expect([...acceptedEncodings('gzip, deflate, br, zstd')]).toEqual(['gzip', 'deflate', 'br', 'zstd']);
    expect([...acceptedEncodings(' BR ; q=1.0 , GZip;q=0.2')]).toEqual(['br', 'gzip']);
    expect([...acceptedEncodings('br;q=0, gzip;q=0.000')]).toEqual([]);
    expect([...acceptedEncodings('br;q=abc, gzip')]).toEqual(['gzip']);
    expect([...acceptedEncodings('*')]).toEqual([]);
    expect([...acceptedEncodings(undefined)]).toEqual([]);
    expect([...acceptedEncodings(['gzip', 'br'])]).toEqual(['gzip', 'br']);
  });
});
