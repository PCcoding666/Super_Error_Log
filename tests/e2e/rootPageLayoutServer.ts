/** Production SSR and assets with synthetic data; no student storage or AI calls. */
import http from 'node:http';
import { renderToStaticMarkup } from 'react-dom/server';
import { CLIENT_SCRIPT, CSS_PATH, JS_PATH, STYLES } from '../../src/web/assets.js';
import type { PhotoView } from '../../src/web/state.js';
import { CapturePage } from '../../src/web/views/photos.js';
import { PracticesPage, type PracticeRow } from '../../src/web/views/practice.js';

const latest: PracticeRow = {
  id: 'synthetic-practice', week: '2026-W43', itemCount: 4,
  status: 'ready', practiceSlot: null, createdAt: '2026-10-20T00:00:00Z', generatedAt: null,
  answered: 0, independentCorrect: null, shortIds: [],
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === CSS_PATH) {
    response.setHeader('content-type', 'text/css');
    response.end(STYLES);
  } else if (url.pathname === JS_PATH) {
    response.setHeader('content-type', 'text/javascript');
    response.end(CLIENT_SCRIPT);
  } else if (url.pathname.startsWith('/s/img/photo/')) {
    const number = Number(url.pathname.split('-').at(-1));
    const [width, height] = number % 2 ? [900, 1600] : [1600, 900];
    response.setHeader('content-type', 'image/svg+xml');
    response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#667766"/></svg>`);
  } else if (url.pathname === '/s/capture') {
    const count = Number(url.searchParams.get('count') ?? 8);
    const photos: PhotoView[] = Array.from({ length: count }, (_, index) => ({
      number: index + 1, jobId: `synthetic-${index + 1}`, registeredAt: '2026-10-20T00:00:00Z',
      job: null, state: index % 3 === 0 ? 'needsPick' : null, failure: null,
      pickDone: false, dismissed: false, itemCount: 0, unselectedCount: 0,
    }));
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html>' + renderToStaticMarkup(CapturePage({ photos, next: null, caption: '' })));
  } else if (url.pathname === '/s/practices') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html>' + renderToStaticMarkup(PracticesPage({ practices: url.searchParams.has('empty') ? [] : [latest] })));
  } else {
    response.writeHead(404).end();
  }
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') process.send?.({ base: `http://127.0.0.1:${address.port}` });
});
const stop = (): void => { server.close(() => process.exit(0)); };
process.once('SIGTERM', stop);
process.once('disconnect', stop);
