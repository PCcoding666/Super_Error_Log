import type { NextFunction, Request, Response } from 'express';
import type { Role } from '../domain/types.js';
import { getProfile, roleFromCookie } from '../services/studentService.js';

declare module 'express-serve-static-core' {
  interface Request {
    role: Role;
  }
}

export function attachRole(req: Request, _res: Response, next: NextFunction): void {
  req.role = roleFromCookie(req.headers.cookie);
  next();
}

export function requireStudent(req: Request, res: Response, next: NextFunction): void {
  if (req.role !== 'student') {
    if (req.originalUrl.startsWith('/api/')) {
      res.status(403).json({ error: '家长视图无权访问学生详细数据' });
      return;
    }
    res.status(403).send(forbiddenHtml());
    return;
  }
  next();
}

export function requireOnboarded(req: Request, res: Response, next: NextFunction): void {
  const open = req.path === '/onboarding' || req.path.startsWith('/api/health') || req.path.startsWith('/public/');
  if (!open && !getProfile()) {
    res.redirect('/onboarding');
    return;
  }
  next();
}

function forbiddenHtml(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>无权访问</title>
<style>body{font-family:system-ui,-apple-system,"PingFang SC",sans-serif;max-width:640px;margin:4rem auto;padding:0 1rem;line-height:1.7}
a.btn{display:inline-block;margin-top:1rem;padding:.7rem 1.4rem;background:#1a56db;color:#fff;border-radius:.5rem;text-decoration:none}</style></head>
<body><h1>此内容仅学生本人可见</h1><p>家长视图只展示汇总趋势，不包含题目内容与私人反思。</p>
<p><a class="btn" href="/parent">返回家长视图</a></p></body></html>`;
}
