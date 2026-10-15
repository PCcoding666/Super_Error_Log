import express from 'express';
import path from 'node:path';
import { attachRole, requireOnboarded } from './routes/middleware.js';
import { apiRouter } from './routes/api.js';
import { pagesRouter } from './routes/pages.js';
import { parentRouter } from './routes/parent.js';
import { evidenceRouter } from './routes/evidence.js';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(express.json({ limit: '2mb' }));
  app.use('/public', express.static(path.resolve('public'), { maxAge: '1h' }));
  app.use(attachRole);
  app.use(requireOnboarded);
  app.use('/api', apiRouter());
  app.use('/parent', parentRouter());
  app.use('/', evidenceRouter());
  app.use('/', pagesRouter());
  return app;
}
