import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Response } from 'express';

export function sendHtml(res: Response, node: ReactNode): void {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>${renderToStaticMarkup(node)}`);
}
