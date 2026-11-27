// 重放多页定位（locate-set）：同提示词、同页序、2048 长边；打印原始输出并复刻 inventorySet/inventory 校验。
import fs from 'node:fs';
import sharp from 'sharp';
import { validateBox } from '/Users/chengpeng/MyProject/Super_Error_Log/src/media/images.ts';
import { MULTI_PAGE_LOCATE_NOTE, MULTI_PAGE_READ_NOTE } from '/Users/chengpeng/MyProject/Super_Error_Log/src/materials/provider.ts';
const [assetsFile, outPath] = process.argv.slice(2);
const assets = fs.readFileSync(assetsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const providerSrc = fs.readFileSync('/Users/chengpeng/MyProject/Super_Error_Log/src/materials/provider.ts', 'utf8');
const SYSTEM = /const SYSTEM = `([\s\S]*?)`;/.exec(providerSrc)[1];
const apiKey = /^SEL_AI_API_KEY=(.*)$/m.exec(fs.readFileSync('/Users/chengpeng/MyProject/Super_Error_Log/.env', 'utf8'))[1].trim();
const ROLES = ['question', 'diagram', 'student_work', 'correction', 'teacher_mark', 'reference_answer', 'unknown'];
const candidateSchema = { key: 'unique string', role: ROLES, box: { x: '0..1', y: '0..1', width: '>0', height: '>0' }, number: 'printed question number|null', subpart: 'printed subpart|null', page: 'positive integer|null', order: 'unique increasing nonnegative integer', requiresDiagram: 'boolean' };
const documentSchema = { title: 'string|null', subject: 'string|null', date: 'string|null', printedCode: 'string|null', page: 'positive integer|null' };
const lead = assets[0];
const source = { assetId: lead.id, revision: lead.revision, sourceHash: lead.content_hash };
const pages = assets.map(a => { const h = JSON.parse(a.hints_json); return { assetId: a.id, revision: a.revision, sourceHash: a.content_hash, pageIndex: h.pageIndex, pageKind: h.pageKind ?? null, path: a.storage_path }; });
const submission = { captureMode: 'multi', pageIndex: 1, pageCount: 2, pageKind: null, instruction: MULTI_PAGE_READ_NOTE };
const payload = { operation: 'locate-set', source, hints: JSON.parse(lead.hints_json), submission: { ...submission, instruction: MULTI_PAGE_LOCATE_NOTE }, pages: pages.map(p => ({ assetId: p.assetId, revision: p.revision, sourceHash: p.sourceHash, pageIndex: p.pageIndex, pageKind: p.pageKind })), schema: { pages: [{ assetId: 'string', document: documentSchema, candidates: [candidateSchema], warnings: ['string'] }] } };
const content = [{ type: 'text', text: JSON.stringify(payload) }];
for (const p of pages) {
  const bytes = await sharp(fs.readFileSync(p.path), { limitInputPixels: 40_000_000 }).resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
  content.push({ type: 'text', text: `第 ${p.pageIndex} 页，未标注，${p.assetId === source.assetId ? '当前页' : '同一提交的其他页'}` });
  content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${bytes.toString('base64')}` } });
}
const started = Date.now();
const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model: 'qwen3.8-27b', messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }], temperature: 0, max_tokens: 8192, response_format: { type: 'json_object' }, enable_thinking: false }) });
const body = await res.json();
console.log('http', res.status, 'ms', Date.now() - started, 'usage', JSON.stringify(body.usage), 'finish', body.choices?.[0]?.finish_reason);
const text = body.choices?.[0]?.message?.content ?? ''; fs.writeFileSync(outPath, text); console.log('raw length', text.length);
let value; try { value = JSON.parse(text); } catch (e) { console.log('NOT JSON', e.message); process.exit(0); }
const fail = (why, extra) => { console.log('INVALID:', why, extra !== undefined ? JSON.stringify(extra).slice(0, 240) : ''); return false; };
function unwrap(v, key) { if (!v || typeof v !== 'object' || Array.isArray(v)) return v; if (key in v) return v; const holds = i => !!i && typeof i === 'object' && !Array.isArray(i) && key in i; for (const n of ['schema', 'result', 'output', 'data']) if (holds(v[n])) return v[n]; for (const n of ['items', 'results']) { const l = v[n]; if (Array.isArray(l) && l.length === 1 && holds(l[0])) return l[0]; } return v; }
const str = (v, max = 16000) => typeof v === 'string' && v.length <= max;
const nullable = (v, max = 256) => v === null || str(v, max);
const number = v => v === null || (str(v, 64) && v.trim() && !/[\r\n]/.test(v));
let ok = true;
const top = unwrap(value, 'pages'); console.log('top keys', Object.keys(top));
if (!Array.isArray(top.pages) || top.pages.length > 8) { fail('pages not array', top.pages); process.exit(0); }
const seen = new Set();
top.pages.forEach((pg, pi) => {
  const tag = `pages[${pi}]`;
  if (!str(pg.assetId, 128)) ok = fail(tag + '.assetId', pg.assetId);
  const src = pages.find(p => p.assetId === pg.assetId); if (!src) ok = fail(tag + ' unknown assetId', pg.assetId); if (seen.has(pg.assetId)) ok = fail(tag + ' duplicate assetId', pg.assetId); seen.add(pg.assetId);
  const v = unwrap(pg, 'candidates');
  if (v.source !== undefined) { const s = v.source; if (!s || !src || s.assetId !== src.assetId || s.revision !== src.revision || s.sourceHash !== src.sourceHash) ok = fail(tag + ' source identity', s); }
  const d = v.document; if (!d || typeof d !== 'object') ok = fail(tag + '.document', d); else { for (const k of ['title', 'subject', 'date', 'printedCode']) if (!nullable(d[k])) ok = fail(tag + '.document.' + k, d[k]); if (!(d.page === null || (Number.isSafeInteger(d.page) && d.page >= 1))) ok = fail(tag + '.document.page', d.page); }
  if (!Array.isArray(v.candidates) || v.candidates.length > 128) { ok = fail(tag + '.candidates', v.candidates?.length); return; }
  const keys = new Set(), orders = new Set(); let prevOrder = null, prevPage = null;
  v.candidates.forEach((c, i) => {
    const ct = `${tag}.cand[${i}]`;
    if (!str(c.key, 64) || !c.key) ok = fail(ct + '.key', c.key); else if (keys.has(c.key)) ok = fail(ct + ' dup key', c.key); keys.add(c.key);
    if (!Number.isSafeInteger(c.order) || c.order < 0) ok = fail(ct + '.order', c.order); else if (orders.has(c.order)) ok = fail(ct + ' dup order', c.order); orders.add(c.order);
    if (!(c.page === null || (Number.isSafeInteger(c.page) && c.page >= 1))) ok = fail(ct + '.page', c.page);
    if (d && d.page !== null && c.page !== null && c.page !== d.page) ok = fail(ct + '.page != document.page', [c.page, d.page]);
    const one = Array.isArray(c.role) && c.role.length === 1 ? c.role[0] : c.role; if (!ROLES.includes(one)) ok = fail(ct + '.role', c.role);
    try { validateBox(c.box); } catch (e) { ok = fail(ct + '.box ' + e.message, c.box); }
    if (!number(c.number)) ok = fail(ct + '.number', c.number); if (!number(c.subpart)) ok = fail(ct + '.subpart', c.subpart);
    if (typeof c.requiresDiagram !== 'boolean') ok = fail(ct + '.requiresDiagram', c.requiresDiagram);
    if (i > 0 && Number.isSafeInteger(c.order) && prevOrder !== null && c.order <= prevOrder) ok = fail(ct + ' order not increasing', [prevOrder, c.order]);
    if (c.page !== null && prevPage !== null && c.page < prevPage) ok = fail(ct + ' page decreasing', [prevPage, c.page]);
    prevOrder = c.order; if (c.page !== null) prevPage = c.page;
  });
  if (!(v.warnings === undefined || v.warnings === null || (Array.isArray(v.warnings) && v.warnings.every(w => str(w, 1000))))) ok = fail(tag + '.warnings', v.warnings);
  console.log(tag, pg.assetId, 'document', JSON.stringify(v.document), 'candidates', v.candidates.length);
});
console.log(ok ? 'VALIDATION PASSED' : 'VALIDATION FAILED');
