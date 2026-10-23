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

/** /s/app/assets/<file>：只接受单段、字符受限的文件名；指纹文件不可变缓存。 */
export function sendClientAsset(request: Request, response: Response): void {
  const dir = clientAppDir();
  const name = String(request.params.file ?? '');
  if (!dir || !ASSET_NAME.test(name)) { response.status(404).type('text').send('not found'); return; }
  const file = path.join(dir, 'assets', name);
  if (!existsSync(file) || !statSync(file).isFile()) { response.status(404).type('text').send('not found'); return; }
  const type = MIME[path.extname(name).toLowerCase()];
  if (!type) { response.status(404).type('text').send('not found'); return; }
  response.setHeader('cache-control', 'public, max-age=31536000, immutable');
  response.setHeader('content-type', type);
  response.send(readFileSync(file));
}

/** 单页应用自己的路由（相对 /s）；其余路径仍由服务端页面处理。 */
export const CLIENT_SHELL_ROUTES = ['/', '/new', '/me', '/q/:id'] as const;
export function isClientShell(pathname: string): boolean {
  return pathname === '/' || pathname === '/new' || pathname === '/me' || /^\/q\/[^/]+$/.test(pathname);
}

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
