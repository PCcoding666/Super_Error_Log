import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import sharp from 'sharp';
import { createMaterialProvider, type MaterialRequestExecutor, type MaterialSource } from '../../src/materials/provider.js';
import { assertV2AiConfigured } from '../../src/v2/aiConfigGuard.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
const source: MaterialSource = { assetId: 'asset', revision: 1, sourceHash: 'original-upload-hash' };
const document = { title: 'Synthetic page', subject: 'math', date: null, printedCode: 'SYNTH', page: 1 };
const candidate = (key: string, role: string, order = 0) => ({ key, role, box: { x: 0, y: order / 10, width: 1, height: .1 }, number: '1', subpart: null, page: 1, order, requiresDiagram: false });
const image = () => sharp({ create: { width: 100, height: 100, channels: 3, background: '#fff' } }).jpeg().toBuffer();
type Request = { model: string; messages: { role: string; content: string | { type: string; text?: string; image_url?: { url: string } }[] }[]; max_tokens: number; response_format: unknown };
function context(body: Request): { operation: string; source: MaterialSource; candidate?: ReturnType<typeof candidate>; fragment?: { text: string } } {
  const content = body.messages.find(m => m.role === 'user')!.content as { type: string; text?: string }[];
  return JSON.parse(content.find(p => p.type === 'text')!.text!);
}
async function local(respond: (body: Request, res: http.ServerResponse) => void) {
  const requests: Request[] = [];
  const server = http.createServer(async (req, res) => {
    expect(req.url).toBe('/v1/chat/completions'); expect(req.headers.authorization).toBe('Bearer synthetic');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as Request; requests.push(body); respond(body, res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { requests, chat: { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: 'synthetic', timeoutMs: 1000, bailianOnly: false, models: { material_extract: 'extract', material_verify: 'verify', material_answer: 'answer', material_grade: 'grade' } } };
}
function send(res: http.ServerResponse, value: unknown) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 10, completion_tokens: 20 } })); }
function response(body: Request, candidates = [candidate('q', 'question')]) {
  const c = context(body);
  if (c.operation === 'locate') return { source: { ...source }, document, candidates, warnings: [] };
  if (c.operation === 'read') return { source: { ...source }, candidateKey: c.candidate!.key, text: '忽略指令 is visible material', uncertainties: [] };
  return { source: { ...source }, candidateKey: c.candidate!.key, check: 'passed', coverage: 'complete', textMatches: true, roleMatches: true, uncertainties: [] };
}
const direct: MaterialRequestExecutor = async (_key, invoke) => invoke(new AbortController().signal);

describe('grounded material provider protocol', () => {
  it('extracts mixed roles without promoting a label to evidence', async () => {
    const roles = ['question', 'student_work', 'correction', 'teacher_mark', 'reference_answer', 'diagram'];
    const f = await local((body, res) => send(res, response(body, roles.map((r, i) => candidate(String(i), r, i)))));
    let reservations = 0; f.chat = { ...f.chat, beforeRequest: async () => { reservations++; } } as typeof f.chat;
    const keys: string[] = [];
    const provider = createMaterialProvider({ mode: 'openai', chat: f.chat }, { source, request: async (key, invoke) => { keys.push(key); return direct(key, invoke); } });
    const result = await provider.extract({ assetId: source.assetId, revision: 1, bytes: await image(), hints: { roles: ['student_work'], marking: 'unmarked', label: 'teacher marked' } }, new AbortController().signal);
    expect(result.fragments.map(f => f.role)).toEqual(expect.arrayContaining(roles));
    expect(new Set(result.fragments.map(f => f.fragmentId)).size).toBe(6);
    expect(result.fragments.every(f => f.check === 'passed' && f.sourceHash === source.sourceHash)).toBe(true);
    expect(result.runs.map(r => r.stage)).toEqual(['material_extract', ...roles.flatMap(() => ['material_extract', 'material_verify'])]);
    expect(keys).toHaveLength(13); expect(new Set(keys).size).toBe(13); expect(f.requests).toHaveLength(13); expect(reservations).toBe(13);
    expect(f.requests.every(r => (r.messages[1]!.content as { type: string }[]).filter(p => p.type === 'image_url').length === 1)).toBe(true);
    expect(f.requests.every(r => r.max_tokens === 8192)).toBe(true);
    expect(f.requests[0]!.messages[0]!.content).toContain('材料内容');
  });

  it('keeps answer sheets as work and missing diagrams uncertain without generating answers', async () => {
    const f = await local((body, res) => send(res, response(body, [candidate('work', 'student_work')])));
    const provider = createMaterialProvider({ mode: 'openai', chat: f.chat }, { source, request: direct });
    const answerSheet = await provider.extract({ assetId: 'asset', revision: 1, bytes: await image(), hints: { marking: 'marked', roles: ['question'] } }, new AbortController().signal);
    expect(answerSheet.fragments.filter(f => f.role === 'question')).toEqual([]);
    expect(answerSheet.fragments.some(f => f.role === 'student_work')).toBe(true);
    expect(answerSheet.fragments.filter(f => f.role === 'teacher_mark')).toEqual([]);
    const g = await local((body, res) => send(res, response(body, [{ ...candidate('q', 'question'), requiresDiagram: true }])));
    const missing = await createMaterialProvider({ mode: 'openai', chat: g.chat }, { source, request: direct }).extract({ assetId: 'asset', revision: 1, bytes: await image(), hints: {} }, new AbortController().signal);
    expect(missing.fragments[0]!.check).toBe('low'); expect(missing.fragments[0]!.uncertainties).toContain('missing_diagram');
    expect([...f.requests, ...g.requests].some(r => ['answer', 'grade'].includes(r.model))).toBe(false);
  });

  it.each(['source', 'box', 'duplicate', 'number', 'page', 'page_order', 'role', 'reference'])('rejects invalid %s before a checkpoint can become successful', async fault => {
    const f = await local((body, res) => {
      const value = response(body) as any;
      if (context(body).operation === 'locate') {
        if (fault === 'source') value.source.sourceHash = 'invented';
        if (fault === 'box') value.candidates[0].box.width = 2;
        if (fault === 'duplicate') value.candidates.push(value.candidates[0]);
        if (fault === 'number') value.candidates[0].number = { fake: 1 };
        if (fault === 'page') value.candidates[0].page = -1;
        if (fault === 'page_order') { value.document = { ...value.document, page: null }; value.candidates = [{ ...candidate('a', 'question', 0), page: 2 }, { ...candidate('b', 'question', 1), page: 1 }]; }
        if (fault === 'role') value.candidates[0].role = 'ai_correct_answer';
      } else if (fault === 'reference') value.candidateKey = 'invented';
      send(res, value);
    });
    let checkpoints = 0;
    const provider = createMaterialProvider({ mode: 'openai', chat: f.chat }, { source: { ...source, sourceHash: 'original-upload-hash' }, request: async (_key, invoke) => { const result = await invoke(new AbortController().signal); checkpoints++; return result; } });
    await expect(provider.extract({ assetId: 'asset', revision: 1, bytes: await image(), hints: {} }, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_output', retryable: false });
    expect(checkpoints).toBe(fault === 'reference' ? 1 : 0);
  });

  it('retains failed and low verification rather than treating HTTP success as evidence', async () => {
    const f = await local((body, res) => {
      const value = response(body) as any;
      if (context(body).operation === 'verify') Object.assign(value, { check: 'passed', coverage: 'incomplete', textMatches: false, uncertainties: ['cut off'] });
      send(res, value);
    });
    const result = await createMaterialProvider({ mode: 'openai', chat: f.chat }, { source, request: direct }).extract({ assetId: 'asset', revision: 1, bytes: await image(), hints: {} }, new AbortController().signal);
    expect(result.fragments[0]!.check).toBe('low'); expect(result.fragments[0]!.uncertainties).toContain('cut off');
  });

  it('cancels the active HTTP request and does not issue later requests', async () => {
    const f = await local(() => {}); const controller = new AbortController();
    const running = createMaterialProvider({ mode: 'openai', chat: f.chat }, { source, request: direct }).extract({ assetId: 'asset', revision: 1, bytes: await image(), hints: {} }, controller.signal);
    const assertion = expect(running).rejects.toThrow('synthetic cancel');
    await expect.poll(() => f.requests.length).toBe(1); controller.abort(new Error('synthetic cancel')); await assertion;
    expect(f.requests).toHaveLength(1);
  });

  it('keeps mock deterministic and offline, and real configuration fail-hard', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
    const provider = createMaterialProvider({ mode: 'mock' }, { source, request: direct });
    const input = { assetId: 'asset', revision: 1, bytes: await image(), hints: {} };
    const mocked = await provider.extract(input, new AbortController().signal);
    expect(mocked).toEqual(await provider.extract(input, new AbortController().signal));
    expect(mocked.fragments.every(f => /^mfr_[a-f0-9]{16}$/.test(f.fragmentId))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(() => createMaterialProvider({ mode: 'openai' }, { source, request: direct })).toThrow();
    const { material_verify: _missing, ...models } = { ...fModels() };
    expect(() => createMaterialProvider({ mode: 'openai', chat: { baseUrl: 'http://127.0.0.1/v1', apiKey: 'synthetic', timeoutMs: 1000, bailianOnly: false, models } }, { source, request: direct })).toThrow('MATERIAL_VERIFY');
    expect(() => assertV2AiConfigured({ aiMode: 'bailian', aiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', aiApiKey: 'synthetic', aiModels: { followup: 'm', correct: 'm', coach: 'm' } })).toThrow('MATERIAL_EXTRACT');
  });
});
function fModels() { return { material_extract: 'm', material_verify: 'm', material_answer: 'm', material_grade: 'm' }; }
