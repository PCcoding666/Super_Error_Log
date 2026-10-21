/** Production SSR and assets with synthetic data; no student storage or AI calls. */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { CLIENT_SCRIPT, CSS_PATH, JS_PATH, STYLES } from '../../src/web/assets.js';
import type { PhotoView } from '../../src/web/state.js';
import { CapturePage } from '../../src/web/views/photos.js';
import { PracticeDashboardPage } from '../../src/web/views/practiceDashboard.js';
import type { PracticeDetail } from '../../src/v2/practiceService.js';

const latest: PracticeDetail = {
  id:'synthetic-practice',week:'2026-W43',status:'ready',practiceSlot:null,createdAt:'2026-10-20T00:00:00Z',generatedAt:null,
  items:Array.from({length:4},(_,i)=>({id:`item-${i}`,position:i,shortId:`M-${i}`,subject:'数学',knowledgeTags:['二次函数与一元二次方程'],questionExcerpt:'解方程',badge:'ok',status:'scheduled',cropUrl:'',jobId:'synthetic',reason:'上次用过提示，这次再试着独立完成',tier:1,reflected:true})),
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
  } else if (/^\/s\/assets\/capture-(page|question)\.[0-9a-f]{10}\.jpg$/.test(url.pathname)) {
    const name = url.pathname.includes('question') ? 'capture-question.jpg' : 'capture-page.jpg';
    response.setHeader('content-type', 'image/jpeg');
    response.end(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/web/examples', name)));
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
    response.end('<!doctype html>' + renderToStaticMarkup(PracticeDashboardPage({tasks:url.searchParams.has('empty')?[]:[{practice:latest,lifecycle:'active',recorded:0,received:0}],activeId:url.searchParams.has('empty')?null:latest.id,recommendation:{recommended:latest.items.slice(0,3),others:[],notes:[],limits:{min:1,max:8}},requestKey:'synthetic'})));
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
