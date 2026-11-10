/**
 * 学生端单页应用（client/，Ionic React）的产物：dist/client/index.html 与 dist/client/assets/*。
 * 发布包只含 dist/，所以产物随服务器一起打包；这里只负责找到它们并下发。
 * - 页面壳由 worker 在 /s/、/s/new、/s/q/:id、/s/me 下发（登录之后）；
 * - 资源文件名带内容指纹，由网关和 worker 共用的公开静态路由 /s/app/assets/<file> 下发，长期缓存。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';

const CANDIDATES = [
  // dist/web/clientApp.js → dist/client
  fileURLToPath(new URL('../client/', import.meta.url)),
  // src/web/clientApp.ts 用 tsx 直接运行（开发、测试）→ 仓库根下的 dist/client
  path.resolve(process.cwd(), 'dist/client/'),
];

/** 产物目录；没有构建过时 null（页面壳路由会给出明确提示，而不是 500）。 */
export function clientAppDir(): string | null {
  return CANDIDATES.find(dir => existsSync(path.join(dir, 'index.html'))) ?? null;
}

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json',
};
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
/** 构建时预压缩的文本资源（client/vite.config.ts 的 precompress），压缩件放在原文件旁边。按优先级排：br 最小，gzip 兜底。 */
const PRECOMPRESSED = [['br', '.br'], ['gzip', '.gz']] as const;
const COMPRESSIBLE = new Set(['.js', '.css', '.svg', '.json']);

function isFile(file: string): boolean {
  return existsSync(file) && statSync(file).isFile();
}

/** Accept-Encoding 里点名接受（q 不为 0）的编码。`*` 不算：只发浏览器明说能解的。 */
export function acceptedEncodings(header: string | string[] | undefined): Set<string> {
  const accepted = new Set<string>();
  for (const part of (Array.isArray(header) ? header.join(',') : header ?? '').split(',')) {
    const [name, ...params] = part.toLowerCase().split(';').map(piece => piece.trim());
    if (!name || name === '*') continue;
    const q = params.find(param => param.startsWith('q='));
    if (q && !(Number(q.slice(2)) > 0)) continue;
    accepted.add(name);
  }
  return accepted;
}

/**
 * /s/app/assets/<file>：只接受单段、字符受限的文件名；指纹文件不可变缓存。
 * 文本资源有预压缩件时按 Accept-Encoding 发压缩件，没有（开发时、旧构建）或浏览器不接受时发原文件。
 * 压缩件本身不能直接请求：.br / .gz 不在 MIME 表里，仍是 404。
 */
export function sendClientAsset(request: Request, response: Response): void {
  const dir = clientAppDir();
  const name = String(request.params.file ?? '');
  if (!dir || !ASSET_NAME.test(name)) { response.status(404).type('text').send('not found'); return; }
  const file = path.join(dir, 'assets', name);
  if (!isFile(file)) { response.status(404).type('text').send('not found'); return; }
  const extension = path.extname(name).toLowerCase();
  const type = MIME[extension];
  if (!type) { response.status(404).type('text').send('not found'); return; }
  response.setHeader('cache-control', 'public, max-age=31536000, immutable');
  response.setHeader('content-type', type);
  if (COMPRESSIBLE.has(extension)) {
    // 同一个地址会按请求头给出不同的字节，中间缓存要按 Accept-Encoding 分开存。
    response.vary('Accept-Encoding');
    const accepted = acceptedEncodings(request.headers['accept-encoding']);
    for (const [encoding, suffix] of PRECOMPRESSED) {
      if (!accepted.has(encoding) || !isFile(file + suffix)) continue;
      response.setHeader('content-encoding', encoding);
      response.send(readFileSync(file + suffix));
      return;
    }
  }
  response.send(readFileSync(file));
}

/** 单页应用自己的路由（相对 /s）；其余路径仍由服务端页面处理。 */
export const CLIENT_SHELL_ROUTES = ['/', '/new', '/me', '/q/:id'] as const;

/** 单页壳：每次读文件（很小），构建更新后无需重启。 */
export function sendClientShell(response: Response): void {
  const dir = clientAppDir();
  response.setHeader('cache-control', 'private, no-store');
  if (!dir) {
    response.status(503).type('html').send('<!doctype html><meta charset="utf-8"><title>还没有构建</title><p>学生端还没有构建：先运行 <code>npm run client:build</code>。</p>');
    return;
  }
  response.type('html').send(readFileSync(path.join(dir, 'index.html'), 'utf8'));
}
