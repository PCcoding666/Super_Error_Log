/** Public shell shared by the invitation gateway and individual student workers. */
import type { Request, Response, Router } from 'express';
import {
  IMMUTABLE, SCRIPT_HASH, SCRIPT_SERVED, SERVICE_WORKER, STYLES_HASH, STYLES_SERVED,
  iconPng, manifest,
} from './assets.js';
import { OfflinePage } from './views/today.js';
import { sendHtml } from '../views/render.js';

function cacheFor(response: Response, value: string): void {
  response.setHeader('cache-control', value);
  response.removeHeader('pragma');
}

/** Register before session auth. Only these explicit, student-independent resources are public. */
export function registerStaticAssets(router: Router): void {
  router.get('/manifest.webmanifest', (_request, response) => {
    cacheFor(response, 'no-cache');
    response.type('application/manifest+json').send(JSON.stringify(manifest()));
  });
  router.get('/sw.js', (_request, response) => {
    cacheFor(response, 'no-cache');
    response.type('text/javascript').send(SERVICE_WORKER);
  });
  router.get(/^\/assets\/app\.([0-9a-f]{10})\.css$/, (request, response) => {
    cacheFor(response, (request.params as Record<string, string>)[0] === STYLES_HASH ? IMMUTABLE : 'no-cache');
    response.type('text/css').send(STYLES_SERVED);
  });
  router.get(/^\/assets\/app\.([0-9a-f]{10})\.js$/, (request, response) => {
    cacheFor(response, (request.params as Record<string, string>)[0] === SCRIPT_HASH ? IMMUTABLE : 'no-cache');
    response.type('text/javascript').send(SCRIPT_SERVED);
  });
  // Old pages/SWs may still request these aliases or a previous fingerprint.
  router.get('/assets/app.css', (_request, response) => {
    cacheFor(response, 'no-cache');
    response.type('text/css').send(STYLES_SERVED);
  });
  router.get('/assets/app.js', (_request, response) => {
    cacheFor(response, 'no-cache');
    response.type('text/javascript').send(SCRIPT_SERVED);
  });
  const icon = (size: number, maskable = false) => async (_request: Request, response: Response): Promise<void> => {
    cacheFor(response, 'public, max-age=604800');
    response.type('image/png').send(await iconPng(size, maskable));
  };
  router.get('/assets/icon-192.png', icon(192));
  router.get('/assets/icon-512.png', icon(512));
  router.get('/assets/icon-maskable-512.png', icon(512, true));
  router.get('/assets/apple-touch-icon.png', icon(180));
  router.get('/offline', (_request, response) => {
    response.setHeader('cache-control', 'private, no-store');
    sendHtml(response, OfflinePage());
  });
}
