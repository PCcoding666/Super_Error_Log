import http from 'node:http';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BailianMobileVision, type VisionAttempt } from '../../src/mobile/vision.js';

// Plan 2026-09-20 Task 1 RED: model-layer coordinate vocabulary switches to native 0-1000
// diagonal integer corners, with schema detection (field-level >1), legacy 0-1 xywh
// compatibility, and clamping. Server contract stays 0-1 xywh — the 0-1000 convention
// exists only inside the model conversation layer.
describe('mobile vision native 0-1000 diagonal coordinate vocabulary', () => {
  let server: http.Server; let baseUrl = ''; let source: Buffer; const requests: any[] = [];
  // boxFormat: which format the fake model responds with for transcribe/ground evidence.
  let mode: 'diag1000' | 'legacy01' | 'mixed' | 'overflow' | 'prompt-only' | 'edge-boundary' = 'diag1000';
  // When false, verify reports a crop failure so the ground stage actually runs
  // (used by the outgoing-vocabulary test to inspect ground prompt encoding).
  let verifyPasses = true;
  const evidenceDiag = (region = { x1: 192, y1: 148, x2: 850, y2: 183 }) => ({
    version: 1, questionNumber: '2', questionText: '若 x=0 是一元二次方程的根，求 a 的值。', subject: '数学', chapter: '', knowledgeTags: [], questionType: '填空题',
    questionRegion: region, requiresDiagram: false,
    regions: [{ id: 'r1', kind: 'student_work', box: { x1: 805, y1: 150, x2: 850, y2: 172 }, confidence: 0.9, cleanForPrint: false }],
    observations: [{ id: 'o1', kind: 'student_work', text: '6', regionId: 'r1', confidence: 0.9 }], uncertainties: [] });
  const candidate = { number: '2', box: { x: 0.235, y: 0.162, width: 0.68, height: 0.025 }, confidence: 0.95, selectionEvidence: 'corrected' as const, partial: false };

  beforeAll(async () => {
    source = await sharp({ create: { width: 120, height: 90, channels: 3, background: { r: 245, g: 235, b: 225 } } }).jpeg().toBuffer();
    server = http.createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); requests.push(body);
      const isTranscribe = body.model === 'transcribe-model';
      const isVerify = body.model === 'verify-model';
      const isInventory = body.model === 'inventory-model';
      let value: unknown;
      if (isInventory) value = { candidates: [{ number: '2', box: { x1: 192, y1: 148, x2: 850, y2: 183 }, confidence: 0.95, selectionEvidence: 'corrected', partial: false }], warnings: [], capacityReached: false };
      else if (isVerify) value = verifyPasses
        ? { textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] }
        : { textComplete: true, questionCropComplete: false, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: ['题目裁图右缘疑似截断'] };
      else if (isTranscribe) {
        if (mode === 'diag1000') value = evidenceDiag();
        else if (mode === 'mixed') value = { ...evidenceDiag(), questionRegion: { x1: 192, y1: 0.148, x2: 850, y2: 0.183 } };
        else if (mode === 'overflow') value = evidenceDiag({ x1: 190, y1: 140, x2: 1050, y2: 190 });
        else if (mode === 'edge-boundary') value = evidenceDiag({ x1: 191.9995, y1: 140, x2: 1000.5, y2: 190 });
        else value = { ...evidenceDiag(), questionRegion: { x: 0.19, y: 0.148, width: 0.66, height: 0.035 },
          regions: [{ id: 'r1', kind: 'student_work', box: { x: 0.805, y: 0.150, width: 0.045, height: 0.022 }, confidence: 0.9, cleanForPrint: false }] };
      } else value = evidenceDiag(); // ground
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 31, completion_tokens: 17 } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  afterAll(() => server.close());
  const make = (attempts: VisionAttempt[]) => new BailianMobileVision({ baseUrl, apiKey: 'synthetic-secret', timeoutMs: 2000, bailianOnly: false,
    models: { inventory: 'inventory-model', transcribe: 'transcribe-model', verify: 'verify-model', ground: 'ground-model' } }, record => { attempts.push(record); });
  const context = { jobId: crypto.randomUUID(), sourceHash: crypto.createHash('sha256').update('source').digest('hex'), questionId: 'q1' };

  it('accepts 0-1000 diagonal-corner evidence and normalizes it to 0-1 xywh contract boxes', async () => {
    mode = 'diag1000'; requests.length = 0; const attempts: VisionAttempt[] = [];
    const result = await make(attempts).recognizeQuestion(source, candidate, context);
    expect(result.evidence.questionRegion).toEqual({ x: 0.192, y: 0.148, width: 0.658, height: 0.035 });
    expect(result.evidence.regions[0]?.box).toEqual({ x: 0.805, y: 0.15, width: 0.045, height: 0.022 });
    expect(result.questionCrop).toBeInstanceOf(Buffer);
    expect(result.questionCrop.length).toBeGreaterThan(0);
  });

  it('resolves mixed-convention boxes by treating the whole group as 0-1000 when any field exceeds 1', async () => {
    mode = 'mixed'; requests.length = 0; const attempts: VisionAttempt[] = [];
    const result = await make(attempts).recognizeQuestion(source, candidate, context);
    // x1=192 (>1) forces whole-box 0-1000 interpretation: y1 0.148*1000=148, y2 183.
    expect(result.evidence.questionRegion).toEqual({ x: 0.192, y: 0.148, width: 0.658, height: 0.035 });
  });

  it('still accepts legacy 0-1 xywh evidence during the transition window', async () => {
    mode = 'legacy01'; requests.length = 0; const attempts: VisionAttempt[] = [];
    const result = await make(attempts).recognizeQuestion(source, candidate, context);
    expect(result.evidence.questionRegion).toEqual({ x: 0.19, y: 0.148, width: 0.66, height: 0.035 });
  });

  it('clamps overflowing 0-1000 corners into the image instead of hard-failing', async () => {
    mode = 'overflow'; requests.length = 0; const attempts: VisionAttempt[] = [];
    const result = await make(attempts).recognizeQuestion(source, candidate, context);
    // x2=1050 clamps to 1000 → width = (1000-190)/1000 = 0.81.
    expect(result.evidence.questionRegion).toEqual({ x: 0.19, y: 0.14, width: 0.81, height: 0.05 });
    expect(result.questionCrop).toBeInstanceOf(Buffer);
  });

  it('never lets rounded edges overshoot the image when the right edge lands on the boundary (review fix: double round-up guard)', async () => {
    mode = 'edge-boundary'; requests.length = 0; const attempts: VisionAttempt[] = [];
    const result = await make(attempts).recognizeQuestion(source, candidate, context);
    // x1=191.9995 → left edge rounds UP to 0.192; right edge clamps to 1.0 → 1.
    // Independent rounding of width used to give 0.808001 (x+width = 1.000001),
    // hard-failing the contract validator. Edges must be rounded first, then the
    // difference taken, so the reconstructed box always stays inside the image.
    expect(result.evidence.questionRegion.x + result.evidence.questionRegion.width).toBeLessThanOrEqual(1);
    expect(result.questionCrop).toBeInstanceOf(Buffer);
  });

  it('encodes candidate and evidence boxes to 0-1000 diagonal corners in outgoing prompts (vocabulary consistency, review fix)', async () => {
    mode = 'diag1000'; verifyPasses = false; requests.length = 0; const attempts: VisionAttempt[] = [];
    const result = await make(attempts).recognizeQuestion(source, candidate, context);
    verifyPasses = true;
    const transcribeRequest = requests.find(request => request.model === 'transcribe-model');
    const groundRequest = requests.find(request => request.model === 'ground-model');
    expect(groundRequest).toBeDefined();
    for (const request of [transcribeRequest, groundRequest]) {
      const texts: string[] = request.messages[1].content.filter((part: any) => part.type === 'text').map((part: any) => part.text);
      const joined = texts.join('\n');
      // candidate.box {x:0.235,y:0.162,width:0.68,height:0.025} must appear as {x1:235,y1:162,x2:915,y2:187}
      expect(joined).toContain('"x1":235');
      expect(joined).toContain('"x2":915');
      // the 0-1 xywh serialization of the same box must not leak into model-facing text
      expect(joined).not.toMatch(/"box":\{"x":0\.235/);
      expect(joined).not.toMatch(/"questionRegion":\{"x":/);
    }
    void result;
  });

  it('asks the model for 0-1000 integer diagonal corners, not 0-1 fractional xywh', async () => {
    mode = 'prompt-only'; requests.length = 0; const attempts: VisionAttempt[] = [];
    const vision = make(attempts);
    await vision.inventory(source, context);
    const inventoryRequest = requests.find(request => request.model === 'inventory-model');
    const promptTexts: string[] = [inventoryRequest.messages[0].content, ...inventoryRequest.messages[1].content.filter((part: any) => part.type === 'text').map((part: any) => part.text)];
    const joined = promptTexts.join('\n');
    expect(joined).toContain('0到1000');
    expect(joined).toContain('x1,y1,x2,y2');
    expect(joined).not.toContain('0到1比例坐标');
  });

  it('instructs inventory candidates to contain the printed question number with margin (Task 3 real-device fix)', async () => {
    mode = 'prompt-only'; requests.length = 0; const attempts: VisionAttempt[] = [];
    const vision = make(attempts);
    await vision.inventory(source, context);
    const inventoryRequest = requests.find(request => request.model === 'inventory-model');
    const promptTexts: string[] = [inventoryRequest.messages[0].content, ...inventoryRequest.messages[1].content.filter((part: any) => part.type === 'text').map((part: any) => part.text)];
    const joined = promptTexts.join('\n');
    // Real-device regression (job bee5ecb3): tight candidate boxes excluded the printed
    // question number ("7." at x≈0.135, box started at 0.166), so every downstream crop
    // failed cropComplete with "missing question number". The inventory prompt must
    // require the number inside the box with margin.
    expect(joined).toContain('印刷题号');
    expect(joined).toContain('余量');
  });
});

// Plan 2026-09-20 Task 2 RED: post-decode box reconciliation against the
// inventory candidate — IoU drift warning, overflow clamp (no hard fail),
// height-inflation clamp. The model's region is kept (AI proposal stays
// auditable); warnings surface in verification.issues for the student.
describe('mobile vision coordinate post-processing (reconcileBox)', () => {
  let server: http.Server; let baseUrl = ''; let source: Buffer; const requests: any[] = [];
  let transcribeRegion: Record<string, unknown> = { x: 0.19, y: 0.148, width: 0.66, height: 0.035 };
  const evidenceWith = (region: Record<string, unknown>) => ({
    version: 1, questionNumber: '2', questionText: '若 x=0 是一元二次方程的根，求 a 的值。', subject: '数学', chapter: '', knowledgeTags: [], questionType: '填空题',
    questionRegion: region, requiresDiagram: false,
    regions: [], observations: [], uncertainties: [] });
  // candidate {x:0.235,y:0.162,width:0.68,height:0.025} — transcribe-phase fixture
  const candidate = { number: '2', box: { x: 0.235, y: 0.162, width: 0.68, height: 0.025 }, confidence: 0.95, selectionEvidence: 'corrected' as const, partial: false };

  beforeAll(async () => {
    source = await sharp({ create: { width: 120, height: 90, channels: 3, background: { r: 245, g: 235, b: 225 } } }).jpeg().toBuffer();
    server = http.createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); requests.push(body);
      const value = body.model === 'verify-model'
        ? { textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] }
        : evidenceWith(transcribeRegion);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 31, completion_tokens: 17 } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  afterAll(() => server.close());
  const make = () => new BailianMobileVision({ baseUrl, apiKey: 'synthetic-secret', timeoutMs: 2000, bailianOnly: false,
    models: { inventory: 'inventory-model', transcribe: 'transcribe-model', verify: 'verify-model', ground: 'ground-model' } });
  const context = { jobId: crypto.randomUUID(), sourceHash: crypto.createHash('sha256').update('source').digest('hex'), questionId: 'q1' };

  it('records a warning into verification.issues when the model box barely overlaps the candidate (IoU < 0.1)', async () => {
    // far corner of the page: zero overlap with candidate at x .235–.915, y .162–.187
    transcribeRegion = { x: 0.02, y: 0.7, width: 0.2, height: 0.05 }; requests.length = 0;
    const result = await make().recognizeQuestion(source, candidate, context);
    // model region is PRESERVED (auditable proposal) but drift is flagged for verify/student
    expect(result.evidence.questionRegion).toEqual({ x: 0.02, y: 0.7, width: 0.2, height: 0.05 });
    expect(result.verification.issues.join('')).toContain('定位漂移');
  });

  it('clamps an overflowing 0-1 box into the image instead of hard-failing invalid_output', async () => {
    // legacy vocabulary response with overflow: x+width = 1.05, y+height = 1.01.
    // Use a tall candidate (height 0.4) so the height-inflation rule stays out of
    // the way — this test isolates the pure overflow clamp.
    const tallCandidate = { ...candidate, box: { x: 0.235, y: 0.15, width: 0.68, height: 0.4 } };
    transcribeRegion = { x: 0.3, y: 0.2, width: 0.75, height: 0.81 }; requests.length = 0;
    const result = await make().recognizeQuestion(source, tallCandidate, context);
    expect(result.evidence.questionRegion).toEqual({ x: 0.3, y: 0.2, width: 0.7, height: 0.8 });
    expect(result.questionCrop).toBeInstanceOf(Buffer);
  });

  it('clamps height inflation (>3x candidate height) to 2x candidate height and records a warning', async () => {
    // candidate height 0.025; model returns height 0.15 (6x) with same vertical span
    transcribeRegion = { x: 0.235, y: 0.148, width: 0.68, height: 0.15 }; requests.length = 0;
    const result = await make().recognizeQuestion(source, candidate, context);
    expect(result.evidence.questionRegion.height).toBeCloseTo(0.05, 6);
    expect(result.verification.issues.join('')).toContain('高度异常');
  });
});
