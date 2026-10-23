import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import sharp from 'sharp';
import { createMaterialProvider, type MaterialRequestExecutor, type MaterialSource } from '../../src/materials/provider.js';
import { assertV2AiConfigured } from '../../src/v2/aiConfigGuard.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
const source: MaterialSource = { assetId: 'asset', revision: 1, sourceHash: 'original-upload-hash' };
const document = { title: 'Synthetic page', subject: 'math', date: null, printedCode: 'SYNTH', page: 1 };
const candidate = (key: string, role: string, order = 0) => ({ key, role, box: { x: 0, y: order / 10, width: 1, height: .1 }, number: '1' as string | null, subpart: null as string | null, page: 1 as number | null, order, requiresDiagram: false });
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

  it.each([
    { label: 'different explicit subparts', number: '1', page: 1, questionSubpart: 'a', diagramSubpart: 'b', expected: 'low' },
    { label: 'unidentified question and diagram', number: null, page: null, questionSubpart: null, diagramSubpart: null, expected: 'low' },
    { label: 'missing question numbers', number: null, page: 1, questionSubpart: 'a', diagramSubpart: 'a', expected: 'low' },
    { label: 'missing page identifiers', number: '1', page: null, questionSubpart: 'a', diagramSubpart: 'a', expected: 'low' },
    { label: 'unproven whole-question diagram for a subpart', number: '1', page: 1, questionSubpart: 'a', diagramSubpart: null, expected: 'low' },
    { label: 'subpart diagram for a whole question', number: '1', page: 1, questionSubpart: null, diagramSubpart: 'a', expected: 'low' },
    { label: 'matching explicit subpart scope', number: '1', page: 1, questionSubpart: 'a', diagramSubpart: 'a', expected: 'passed' },
    { label: 'matching explicit whole-question scope', number: '1', page: 1, questionSubpart: null, diagramSubpart: null, expected: 'passed' },
  ])('requires compatible diagram evidence: $label', async ({ number, page, questionSubpart, diagramSubpart, expected }) => {
    const candidates = [
      { ...candidate('question', 'question', 0), number, page, subpart: questionSubpart, requiresDiagram: true },
      { ...candidate('diagram', 'diagram', 1), number, page, subpart: diagramSubpart },
    ];
    const f = await local((body, res) => {
      const value = response(body, candidates);
      if (context(body).operation === 'locate') Object.assign(value, { document: { ...document, page: null } });
      send(res, value);
    });
    const extraction = await createMaterialProvider({ mode: 'openai', chat: f.chat }, { source, request: direct }).extract({ assetId: 'asset', revision: 1, bytes: await image(), hints: {} }, new AbortController().signal);
    const question = extraction.fragments.find(f => f.role === 'question')!;
    expect(question.check).toBe(expected);
    if (expected === 'low') expect(question.uncertainties).toContain('missing_diagram');
    else expect(question.uncertainties).toEqual([]);
    expect(extraction.fragments.find(f => f.role === 'diagram')!.check).toBe('passed');
    expect(f.requests).toHaveLength(5);
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

  // Shapes observed from qwen3.8-max, qwen3.8-27b, qwen3.6-plus and qwen3-vl-plus on a real photo:
  // no source echo, roles as one-item lists, a read that mirrors the request, a verification wrapped in `schema`.
  it('accepts the output shapes real models return without loosening content checks', async () => {
    const f = await local((body, res) => {
      const c = context(body);
      if (c.operation === 'locate') send(res, { document, candidates: [{ ...candidate('q', 'question', 0), role: ['question'] }, { ...candidate('w', 'student_work', 1), role: ['student_work'] }], warnings: [] });
      else if (c.operation === 'read') send(res, { operation: 'read', source: { ...source }, items: [{ ...c.candidate!, text: `visible ${c.candidate!.key}`, uncertainties: [] }] });
      else send(res, { schema: { candidateKey: c.candidate!.key, check: 'passed', coverage: 'complete', textMatches: true, roleMatches: true, uncertainties: [] } });
    });
    const result = await createMaterialProvider({ mode: 'openai', chat: f.chat }, { source, request: direct }).extract({ assetId: 'asset', revision: 1, bytes: await image(), hints: {} }, new AbortController().signal);
    expect(result.fragments.map(x => [x.role, x.text, x.check])).toEqual([['question', 'visible q', 'passed'], ['student_work', 'visible w', 'passed']]);
    expect(result.fragments.every(x => x.sourceHash === source.sourceHash)).toBe(true);
    expect(result.runs.every(r => r.promptVersion === 'material-v1.1')).toBe(true);
    expect(f.requests[0]!.messages[0]!.content).toContain('不要外包schema');
  });

  it.each(['two-roles', 'mirrored-key', 'wrapped-key', 'wrapped-source'])('still rejects %s after unwrapping', async fault => {
    const f = await local((body, res) => {
      const c = context(body);
      if (c.operation === 'locate') send(res, { document, candidates: [{ ...candidate('q', 'question', 0), role: fault === 'two-roles' ? ['question', 'student_work'] : 'question' }], warnings: [] });
      else if (c.operation === 'read') send(res, { items: [{ key: fault === 'mirrored-key' ? 'another' : c.candidate!.key, text: 'visible', uncertainties: [] }] });
      else send(res, { schema: { candidateKey: fault === 'wrapped-key' ? 'another' : c.candidate!.key, ...(fault === 'wrapped-source' ? { source: { ...source, sourceHash: 'invented' } } : {}), check: 'passed', coverage: 'complete', textMatches: true, roleMatches: true, uncertainties: [] } });
    });
    await expect(createMaterialProvider({ mode: 'openai', chat: f.chat }, { source, request: direct }).extract({ assetId: 'asset', revision: 1, bytes: await image(), hints: {} }, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_output' });
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

describe('trial scope 数学/物理/化学', () => {
  it('stops after the single locate call for a clearly other-subject paper, with no reads, verifications or failure', async () => {
    const f = await local((body, res) => {
      const c = context(body);
      if (c.operation === 'locate') { send(res, { source: { ...source }, document: { ...document, subject: '英语' }, candidates: [candidate('q', 'question'), candidate('w', 'student_work', 1)], warnings: [] }); return; }
      send(res, response(body));
    });
    const provider = createMaterialProvider({ mode: 'openai', chat: f.chat }, { source, request: direct });
    const result = await provider.extract({ assetId: source.assetId, revision: 1, bytes: await image(), hints: {} }, new AbortController().signal);
    expect(f.requests).toHaveLength(1);
    expect(result.fragments).toEqual([]);
    expect(result.document.subject).toBe('英语');
    expect(result.warnings).toContain('unsupported_subject');
  });
  it('still extracts a supported or unnamed subject normally', async () => {
    for (const subject of ['数学', null]) {
      const f = await local((body, res) => {
        const c = context(body);
        if (c.operation === 'locate') { send(res, { source: { ...source }, document: { ...document, subject }, candidates: [candidate('q', 'question')], warnings: [] }); return; }
        send(res, response(body));
      });
      const provider = createMaterialProvider({ mode: 'openai', chat: f.chat }, { source, request: direct });
      const result = await provider.extract({ assetId: source.assetId, revision: 1, bytes: await image(), hints: {} }, new AbortController().signal);
      expect(f.requests).toHaveLength(3); expect(result.fragments).toHaveLength(1);
    }
  });
});
