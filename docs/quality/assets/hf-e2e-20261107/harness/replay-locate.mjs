// 重放材料流程的 locate 调用（同提示词、同图片、同参数），打印原始模型输出并逐条复刻 inventory 校验，找出 invalid_output 的具体原因。
import fs from 'node:fs';
import sharp from 'sharp';
import { validateBox } from '/Users/chengpeng/MyProject/Super_Error_Log/src/media/images.ts';
const [imagePath, assetId, sourceHash, outPath] = process.argv.slice(2);
const providerSrc = fs.readFileSync('/Users/chengpeng/MyProject/Super_Error_Log/src/materials/provider.ts', 'utf8');
const SYSTEM = /const SYSTEM = `([\s\S]*?)`;/.exec(providerSrc)[1];
const env = fs.readFileSync('/Users/chengpeng/MyProject/Super_Error_Log/.env', 'utf8');
const apiKey = /^SEL_AI_API_KEY=(.*)$/m.exec(env)[1].trim();
const ROLES = ['question', 'diagram', 'student_work', 'correction', 'teacher_mark', 'reference_answer', 'unknown'];
const candidateSchema = { key: 'unique string', role: ROLES, box: { x: '0..1', y: '0..1', width: '>0', height: '>0' }, number: 'printed question number|null', subpart: 'printed subpart|null', page: 'positive integer|null', order: 'unique increasing nonnegative integer', requiresDiagram: 'boolean' };
const documentSchema = { title: 'string|null', subject: 'string|null', date: 'string|null', printedCode: 'string|null', page: 'positive integer|null' };
const source = { assetId, revision: 1, sourceHash };
const bytes = await sharp(fs.readFileSync(imagePath), { limitInputPixels: 40_000_000 }).resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
const payload = { operation: 'locate', source, hints: { captureMode: 'single' }, schema: { document: documentSchema, candidates: [candidateSchema], warnings: ['string'] } };
const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: [{ type: 'text', text: JSON.stringify(payload) }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${bytes.toString('base64')}` } }] }];
const started = Date.now();
const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model: 'qwen3.8-27b', messages, temperature: 0, max_tokens: 8192, response_format: { type: 'json_object' }, enable_thinking: false }) });
const body = await res.json();
console.log('http', res.status, 'ms', Date.now() - started, 'usage', JSON.stringify(body.usage), 'finish', body.choices?.[0]?.finish_reason);
const content = body.choices?.[0]?.message?.content ?? '';
fs.writeFileSync(outPath, content);
console.log('raw length', content.length);
let value; try { value = JSON.parse(content); } catch (e) { console.log('NOT JSON:', e.message); process.exit(0); }
// ---- 复刻 inventory() 校验 ----
const fail = (why, extra) => { console.log('INVALID:', why, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); return false; };
function unwrap(v, key) { if (!v || typeof v !== 'object' || Array.isArray(v)) return v; if (key in v) return v; const holds = i => !!i && typeof i === 'object' && !Array.isArray(i) && key in i; for (const n of ['schema', 'result', 'output', 'data']) if (holds(v[n])) return v[n]; for (const n of ['items', 'results']) { const l = v[n]; if (Array.isArray(l) && l.length === 1 && holds(l[0])) return l[0]; } return v; }
const str = (v, max = 16000) => typeof v === 'string' && v.length <= max;
const nullable = (v, max = 256) => v === null || str(v, max);
const number = v => v === null || (str(v, 64) && v.trim() && !/[\r\n]/.test(v));
const v = unwrap(value, 'candidates');
console.log('top-level keys:', Object.keys(v));
let ok = true;
if (v.source !== undefined) { const s = v.source; if (!s || s.assetId !== source.assetId || s.revision !== source.revision || s.sourceHash !== source.sourceHash) ok = fail('source identity mismatch', s); }
const d = v.document; if (!d || typeof d !== 'object' || Array.isArray(d)) ok = fail('document not object', d); else { for (const k of ['title', 'subject', 'date', 'printedCode']) if (!nullable(d[k])) ok = fail('document.' + k, d[k]); if (!(d.page === null || (Number.isSafeInteger(d.page) && d.page >= 1))) ok = fail('document.page', d.page); }
if (!Array.isArray(v.candidates) || v.candidates.length > 128) ok = fail('candidates not array/too many', v.candidates?.length);
else {
  const keys = new Set(), orders = new Set(); let prevOrder = null, prevPage = null;
  v.candidates.forEach((c, i) => {
    if (!c || typeof c !== 'object') return ok = fail(`cand[${i}] not object`, c);
    if (!str(c.key, 64) || !c.key) ok = fail(`cand[${i}].key`, c.key); else if (keys.has(c.key)) ok = fail(`cand[${i}] duplicate key`, c.key); keys.add(c.key);
    if (!Number.isSafeInteger(c.order) || c.order < 0) ok = fail(`cand[${i}].order`, c.order); else if (orders.has(c.order)) ok = fail(`cand[${i}] duplicate order`, c.order); orders.add(c.order);
    if (!(c.page === null || (Number.isSafeInteger(c.page) && c.page >= 1))) ok = fail(`cand[${i}].page`, c.page);
    if (d && d.page !== null && c.page !== null && c.page !== d.page) ok = fail(`cand[${i}].page != document.page`, [c.page, d.page]);
    const one = Array.isArray(c.role) && c.role.length === 1 ? c.role[0] : c.role; if (!ROLES.includes(one)) ok = fail(`cand[${i}].role`, c.role);
    try { validateBox(c.box); } catch (e) { ok = fail(`cand[${i}].box ${e.message}`, c.box); }
    if (!number(c.number)) ok = fail(`cand[${i}].number`, c.number); if (!number(c.subpart)) ok = fail(`cand[${i}].subpart`, c.subpart);
    if (typeof c.requiresDiagram !== 'boolean') ok = fail(`cand[${i}].requiresDiagram`, c.requiresDiagram);
    if (i > 0 && Number.isSafeInteger(c.order) && prevOrder !== null && c.order <= prevOrder) ok = fail(`cand[${i}].order not increasing`, [prevOrder, c.order]);
    if (c.page !== null && prevPage !== null && c.page < prevPage) ok = fail(`cand[${i}].page decreasing`, [prevPage, c.page]);
    prevOrder = c.order; if (c.page !== null) prevPage = c.page;
  });
}
if (!Array.isArray(v.warnings) || v.warnings.length > 128 || !v.warnings.every(w => str(w, 1000))) ok = fail('warnings', v.warnings);
console.log(ok ? 'VALIDATION PASSED (would be accepted)' : 'VALIDATION FAILED (see INVALID lines)');
console.log('document:', JSON.stringify(v.document), 'candidates:', v.candidates?.length);
