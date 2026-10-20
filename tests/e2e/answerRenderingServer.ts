import express from 'express';
import { renderToStaticMarkup } from 'react-dom/server';
import { registerStaticAssets } from '../../src/web/staticAssets.js';
import { ItemDetailPage } from '../../src/web/views/itemDetail.js';
import { answerItem, LONG_ANSWER } from '../fixtures/answerRendering.js';

// Use tsx in a child process so Playwright's component transform cannot rewrite React elements.
const app = express();
const assets = express.Router();
registerStaticAssets(assets);
app.use('/s', assets);
app.get('/large.css', (_request, response) => { response.type('css').send('html{font-size:200%}'); });
app.get('/s/items/synthetic', (request, response) => {
  response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'");
  const html = '<!DOCTYPE html>' + renderToStaticMarkup(ItemDetailPage({
    item: answerItem, reflected: false, canDiscard: true,
    evidence: { questionText: '合成题目：求抛物线解析式及点的坐标。', subject: '数学', knowledgeTags: [], revision: 1, badge: 'ok',
      observations: [
        { id: 'work', kind: 'student_work', text: LONG_ANSWER },
        { id: 'teacher', kind: 'teacher_note', text: '-2' },
        { id: 'long', kind: 'unknown', text: `长公式：\\[\\frac{${Array.from({ length: 35 }, (_, i) => `x_{${i}}`).join('+')}}{3}\\]` },
      ] },
  }));
  response.type('html').send(request.query.large === '1' ? html.replace('</head>', '<link rel="stylesheet" href="/large.css"/></head>') : html);
});
const server = app.listen(0, '127.0.0.1', () => {
  process.send?.({ base: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
});
process.once('SIGTERM', () => { server.close(() => process.exit(0)); });
