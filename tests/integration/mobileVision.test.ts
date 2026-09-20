import http from 'node:http';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { cropPhoto } from '../../src/media/images.js';
import { validateEvidence } from '../../src/ai/evidence.js';
import { expandCropMargin } from '../../src/mobile/modelBox.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BailianMobileVision, MobileVisionError, type VisionAttempt } from '../../src/mobile/vision.js';

describe('mobile vision adapter over a real local HTTP boundary', () => {
  let server: http.Server; let baseUrl = ''; let source: Buffer; const requests: any[] = [];
  let mode: 'pass' | 'inventory-warning' | 'invalid' | 'bare-array' | 'verify-array' | 'bad-schema' | 'bad-question-format' | 'currency' | 'currency-english' | 'currency-inline' | 'truncated' | 'oversized' | 'ground' | 'ground-crop-fail' | 'transient' | 'auth' | 'verify-auth' | 'capacity' | 'echo-key' = 'pass'; let transientCalls = 0;
  let optionalWarning: unknown;
  const evidence = (box = { x: .1, y: .1, width: .8, height: .7 }) => ({ version: 1, questionNumber: '4', questionText: '求 x 的值。', subject: '数学', chapter: '', knowledgeTags: [], questionType: '计算', questionRegion: box,
    requiresDiagram: true, regions: [{ id: 'd1', kind: 'diagram', box: { x: .2, y: .2, width: .2, height: .2 }, confidence: .9, cleanForPrint: true }], observations: [], uncertainties: [] });
  beforeAll(async () => {
    source = await sharp({ create: { width: 80, height: 60, channels: 3, background: { r: 245, g: 235, b: 225 } } }).jpeg().toBuffer();
    server = http.createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); requests.push(body);
      if (mode === 'auth') { res.writeHead(401).end('{"error":"bad key"}'); return; }
      if (mode === 'verify-auth' && body.model === 'verify-model') { res.writeHead(401).end('{"error":"bad key"}'); return; }
      if (mode === 'transient' && transientCalls++ < 2) { res.writeHead(503).end('{"error":"busy"}'); return; }
      const normalInventory = { candidates: [{ number: '4', box: { x: 0, y: 0, width: .5, height: 1 }, confidence: .8, selectionEvidence: 'marked_wrong', partial: false }, { number: '4', box: { x: .5, y: 0, width: .5, height: 1 }, confidence: .7, selectionEvidence: 'unmarked', partial: true, warning: '右侧被截断' }], warnings: ['页面右缘残缺'], capacityReached: false };
      const value = body.model === 'inventory-model'
        ? mode === 'bad-schema' ? { candidates: [{}], warnings: [], capacityReached: false }
          : mode === 'inventory-warning' ? { ...normalInventory, candidates: normalInventory.candidates.map(candidate => ({ ...candidate, warning: optionalWarning })) }
          : mode === 'capacity' ? { candidates: Array.from({ length: 31 }, (_, index) => ({ number: String(index), box: { x: 0, y: 0, width: 1, height: 1 }, confidence: .8, selectionEvidence: 'unmarked', partial: false })), warnings: [], capacityReached: true }
          : normalInventory
        : body.model === 'transcribe-model' ? { ...evidence(), ...(mode === 'bad-question-format' ? { questionText: '计算 $\\frac{1}{2}$。' }
          : mode === 'currency' ? { questionText: '一本书售价 $5，另一本售价 $10，一共多少？' }
            : mode === 'currency-english' ? { questionText: 'Book A costs $5. Book B costs $10.' }
              : mode === 'currency-inline' ? { questionText: '价格分别是$5和$10，求总价。' } : {}) }
        : body.model === 'ground-model' ? evidence({ x: 0, y: 0, width: 1, height: 1 })
        : { textComplete: true, questionCropComplete: !['ground', 'ground-crop-fail'].includes(mode) || requests.filter(request => request.model === 'verify-model').length >= (mode === 'ground' ? 3 : 2),
            questionCropPure: true, transcriptionMatches: true, diagramSafe: true,
            issues: ['ground', 'ground-crop-fail'].includes(mode) && requests.filter(request => request.model === 'verify-model').length < (mode === 'ground' ? 3 : 2) ? ['题框缺少条件'] : [] };
      const content = mode === 'invalid' ? '{not-json' : JSON.stringify(mode === 'bare-array' ? [{ number: '4', box: [0, 0, 1, 1] }] : mode === 'verify-array' && body.model === 'verify-model' ? [value] : value);
      res.setHeader('content-type', 'application/json');
      if (mode === 'oversized') { res.end('x'.repeat(2_100_000)); return; }
      if (mode === 'ground-crop-fail' && body.model === 'ground-model') source.fill(0);
      res.end(JSON.stringify({ choices: [{ finish_reason: mode === 'truncated' ? 'length' : 'stop', message: { content } }], usage: { prompt_tokens: 31, completion_tokens: 17 }, ...(mode === 'echo-key' ? { echo: 'synthetic-secret' } : {}) }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  afterAll(() => server.close());
  const make = (attempts: VisionAttempt[], key = 'synthetic-secret') => new BailianMobileVision({ baseUrl, apiKey: key, timeoutMs: 2000, bailianOnly: false,
    models: { inventory: 'inventory-model', transcribe: 'transcribe-model', verify: 'verify-model', ground: 'ground-model' } }, record => { attempts.push(record); });
  const context = { jobId: crypto.randomUUID(), sourceHash: crypto.createHash('sha256').update('source').digest('hex'), questionId: null };

  it('sends the actual full-page bytes and keeps duplicate printed numbers as separate positioned candidates', async () => {
    mode = 'pass'; requests.length = 0; const attempts: VisionAttempt[] = [];
    const result = await make(attempts).inventory(source, context);
    expect(result.candidates.map(candidate => candidate.number)).toEqual(['4', '4']);
    expect(result.candidates[1]).toMatchObject({ partial: true, warning: '右侧被截断' });
    const imageUrl = requests[0].messages[1].content.find((part: any) => part.type === 'image_url').image_url.url;
    expect(Buffer.from(imageUrl.split(',')[1], 'base64')).toEqual(source);
  });

  it('places the explicit inventory object contract after the unchanged image and still rejects bare arrays once', async () => {
    mode = 'bare-array'; requests.length = 0; const attempts: VisionAttempt[] = [];
    await expect(make(attempts).inventory(source, context)).rejects.toMatchObject({ code: 'invalid_output', retryable: false });
    const parts = requests[0].messages[1].content;
    expect(parts.at(-1)).toMatchObject({ type: 'text', text: expect.stringContaining('输出必须是顶层JSON对象，不是数组') });
    expect(parts.at(-1).text).toContain('box必须是对象，禁止数组');
    expect(Buffer.from(parts.find((part: any) => part.type === 'image_url').image_url.url.split(',')[1], 'base64')).toEqual(source);
    expect(requests).toHaveLength(1);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ responseRaw: expect.stringContaining('box'), error: { code: 'invalid_output' } });
  });

  it.each([
    { label: 'absent', value: undefined },
    { label: 'null', value: null },
    { label: 'empty', value: '' },
    { label: 'whitespace', value: ' \t\n ' },
  ])('keeps every inventory candidate and partial flag with $label optional warning', async ({ value }) => {
    mode = 'inventory-warning'; optionalWarning = value; requests.length = 0; const attempts: VisionAttempt[] = [];
    const result = await make(attempts).inventory(source, context);
    expect(result).toEqual({ candidates: [
      { number: '4', box: { x: 0, y: 0, width: .5, height: 1 }, confidence: .8, selectionEvidence: 'marked_wrong', partial: false },
      { number: '4', box: { x: .5, y: 0, width: .5, height: 1 }, confidence: .7, selectionEvidence: 'unmarked', partial: true },
    ], warnings: ['页面右缘残缺'] });
    expect(requests).toHaveLength(1);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.error).toBeNull();
  });

  it('preserves nonempty optional inventory warning text exactly', async () => {
    mode = 'inventory-warning'; optionalWarning = '  合成警告：右缘不完整  ';
    const result = await make([]).inventory(source, context);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map(candidate => candidate.warning)).toEqual(['  合成警告：右缘不完整  ', '  合成警告：右缘不完整  ']);
    expect(result.candidates[1]?.partial).toBe(true);
    expect(result.warnings).toEqual(['页面右缘残缺', '  合成警告：右缘不完整  ']);
  });

  // null warning is accepted as absent since 2026-09-20: real-device inventory
  // (job bee5ecb3, qwen3.8-max) emits "warning": null on 8/13 candidates and the
  // strict rejection killed the whole job. Real nonstring values stay rejected.
  it.each([7, {}, [], false])('rejects nonstring optional inventory warning %j without retry and retains raw evidence', async value => {
    mode = 'inventory-warning'; optionalWarning = value; requests.length = 0; const attempts: VisionAttempt[] = [];
    await expect(make(attempts).inventory(source, context)).rejects.toMatchObject({ code: 'invalid_output', retryable: false });
    expect(requests).toHaveLength(1);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ responseRaw: expect.stringContaining('warning'), error: { code: 'invalid_output' } });
  });

  it('transcribes from the full original then verifies actual question and diagram crops without trusting model clean labels', async () => {
    mode = 'pass'; requests.length = 0; const attempts: VisionAttempt[] = [];
    const candidate = { number: '4', box: { x: 0, y: 0, width: 1, height: 1 }, selectionEvidence: 'marked_wrong' as const, partial: false };
    const result = await make(attempts).recognizeQuestion(source, candidate, { ...context, questionId: crypto.randomUUID() });
    expect(result.evidence.regions[0]?.cleanForPrint).toBe(false);
    expect(result.verification).toEqual({ textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] });
    const transcribe = requests.find(request => request.model === 'transcribe-model');
    expect(Buffer.from(transcribe.messages[1].content.find((p: any) => p.type === 'image_url').image_url.url.split(',')[1], 'base64')).toEqual(source);
    const verify = requests.find(request => request.model === 'verify-model');
    expect(verify.messages[1].content.filter((p: any) => p.type === 'image_url')).toHaveLength(3);
    expect(result.questionCrop.equals(source)).toBe(false);
    expect(result.diagramCrops).toHaveLength(1);
    expect(JSON.stringify(attempts)).not.toContain('synthetic-secret');
    expect(JSON.stringify(attempts)).not.toContain('base64');
    expect(attempts.at(-1)).toMatchObject({ responseRaw: expect.stringContaining('prompt_tokens'), usage: { prompt_tokens: 31, completion_tokens: 17 } });
  });

  it('verifies the original candidate occurrence and stable identity after a saved checkpoint and hashes actual messages', async () => {
    mode = 'pass'; requests.length = 0; const attempts: VisionAttempt[] = [];
    const candidate = { number: '4', box: { x: .6, y: .1, width: .3, height: .7 }, selectionEvidence: 'unmarked' as const, partial: false };
    const questionId = crypto.randomUUID();
    await make(attempts).recognizeQuestion(source, candidate, { ...context, questionId,
      resumeCheckpoint: { evidence: validateEvidence(evidence()), verification: null, nextStage: 'verify', groundingPasses: 0 } });
    expect(requests.map(request => request.model)).toEqual(['verify-model']);
    const verifyInput = JSON.parse(requests[0].messages[1].content[0].text);
    // model-conversation layer encodes boxes as 0-1000 diagonal corners; the 0-1
    // contract box {x:.6,y:.1,width:.3,height:.7} becomes {x1:600,y1:100,x2:900,y2:800}
    expect(verifyInput.candidate).toEqual({ number: '4', box: { x1: 600, y1: 100, x2: 900, y2: 800 }, selectionEvidence: 'unmarked', partial: false });
    expect(verifyInput.candidateId).toBe(questionId);
    expect(requests[0].messages[1].content.at(-1).text).toContain('同题号不代表同一处');
    expect(requests[0].messages[1].content.at(-1).text).toContain('本题自己的原作过程或订正可以在题目裁图内');
    expect(requests[0].messages[1].content.at(-1).text).toContain('不能混入印刷questionText或可打印图示');
    expect(attempts[0]?.request.promptHash).toBe(crypto.createHash('sha256').update(JSON.stringify(requests[0].messages)).digest('hex'));
    expect(attempts[0]?.request.sourceHash).toBe(context.sourceHash);
  });

  it('does not classify invalid local image input as recoverable model configuration', async () => {
    mode = 'pass'; requests.length = 0;
    await expect(make([]).inventory(Buffer.from('synthetic invalid image'), context)).rejects.toMatchObject({ code: 'invalid_image', retryable: false });
    expect(requests).toHaveLength(0);
  });

  it('appends transcribe candidate contract after unchanged source and rejects another question once', async () => {
    mode = 'pass'; requests.length = 0; const attempts: VisionAttempt[] = [];
    const candidate = { number: '11"\\目标', box: { x: 0, y: 0, width: 1, height: 1 }, selectionEvidence: 'unclear' as const, partial: false };
    await expect(make(attempts).recognizeQuestion(source, candidate, context))
      .rejects.toMatchObject({ code: 'invalid_output', stage: 'transcribe', retryable: false });
    const parts = requests[0].messages[1].content;
    expect(parts.map((part: any) => part.type)).toEqual(['text', 'image_url', 'text']);
    expect(parts.at(-1).text).toContain(`只读取候选题号 ${JSON.stringify(candidate.number)}`);
    expect(parts.at(-1).text).toContain('找不到该候选时不得读取其他题目');
    expect(parts.at(-1).text).toContain('完整Evidence JSON契约');
    expect(parts.at(-1).text).toContain('保留原题实际内容和手写错误');
    expect(Buffer.from(parts[1].image_url.url.split(',')[1], 'base64')).toEqual(source);
    expect(requests).toHaveLength(1); expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ error: { code: 'invalid_output' }, responseRaw: expect.stringContaining('questionNumber') });
  });

  it('appends verify image-role object contract and still rejects a top-level array without retry', async () => {
    mode = 'verify-array'; requests.length = 0; const attempts: VisionAttempt[] = [];
    await expect(make(attempts).recognizeQuestion(source, { number: '4', box: { x: 0, y: 0, width: 1, height: 1 }, selectionEvidence: 'unclear', partial: false }, context))
      .rejects.toMatchObject({ code: 'invalid_output', retryable: false });
    const parts = requests.find(request => request.model === 'verify-model').messages[1].content;
    expect(parts.map((part: any) => part.type)).toEqual(['text', 'image_url', 'image_url', 'image_url', 'text']);
    expect(parts.at(-1).text).toContain('第1张图是完整原图，第2张图是实际题目裁图，第3张及之后的图是实际图示裁图');
    expect(parts.at(-1).text).toContain('顶层JSON对象，不是数组');
    for (const field of ['textComplete', 'questionCropComplete', 'questionCropPure', 'transcriptionMatches', 'diagramSafe', 'issues']) expect(parts.at(-1).text).toContain(`"${field}"`);
    expect(parts.at(-1).text).toContain('不得因字段存在就判定成功');
    // Task 4: question crops render with the deterministic margin expansion; diagram
    // crops stay on the raw model box.
    const expected = [source, await cropPhoto(source, expandCropMargin(evidence().questionRegion)), await cropPhoto(source, evidence().regions[0]!.box)];
    expect(parts.filter((part: any) => part.type === 'image_url').map((part: any) => Buffer.from(part.image_url.url.split(',')[1], 'base64'))).toEqual(expected);
    expect(requests.filter(request => request.model === 'verify-model')).toHaveLength(1);
    expect(attempts.filter(attempt => attempt.stage === 'verify')).toHaveLength(1);
    expect(attempts.at(-1)).toMatchObject({ stage: 'verify', error: { code: 'invalid_output' }, responseRaw: expect.stringContaining('textComplete') });
  });

  it('appends ground candidate image-role and original-coordinate contract without relabeling wrong output', async () => {
    mode = 'pass'; requests.length = 0; const attempts: VisionAttempt[] = [];
    const candidate = { number: '11"\\目标', box: { x: 0, y: 0, width: 1, height: 1 }, selectionEvidence: 'unclear' as const, partial: false };
    const previous = { ...evidence(), questionNumber: candidate.number };
    await expect(make(attempts).recognizeQuestion(source, candidate, { ...context, resumeCheckpoint: {
      evidence: previous as any, verification: { textComplete: false, questionCropComplete: false, questionCropPure: false, transcriptionMatches: false, diagramSafe: false, issues: ['题框缺少条件'] }, nextStage: 'ground', groundingPasses: 0,
    } })).rejects.toMatchObject({ code: 'invalid_output', stage: 'ground', retryable: false });
    const parts = requests[0].messages[1].content;
    expect(parts.map((part: any) => part.type)).toEqual(['text', 'image_url', 'image_url', 'image_url', 'text']);
    expect(parts.at(-1).text).toContain(`只读取候选题号 ${JSON.stringify(candidate.number)}`);
    expect(parts.at(-1).text).toContain('第1张图是完整原图，第2张图是实际题目裁图，第3张及之后的图是实际图示裁图');
    expect(parts.at(-1).text).toContain('坐标只参照第1张完整原图，绝不能使用裁图坐标');
    expect(parts.at(-1).text).toContain('原样返回有问题的旧裁框并宣称成功');
    expect(parts.at(-1).text).toContain('完整Evidence JSON契约');
    const expected = [source, await cropPhoto(source, expandCropMargin(previous.questionRegion)), await cropPhoto(source, previous.regions[0]!.box)];
    expect(parts.filter((part: any) => part.type === 'image_url').map((part: any) => Buffer.from(part.image_url.url.split(',')[1], 'base64'))).toEqual(expected);
    expect(requests).toHaveLength(1); expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ stage: 'ground', error: { code: 'invalid_output' } });
  });

  it('supplies the complete Evidence contract to both transcription and corrective grounding calls', async () => {
    mode = 'ground'; requests.length = 0; const attempts: VisionAttempt[] = [];
    await make(attempts).recognizeQuestion(source, { number: '4', box: { x: 0, y: 0, width: 1, height: 1 }, selectionEvidence: 'unclear', partial: false }, { ...context, questionId: crypto.randomUUID() });
    for (const model of ['transcribe-model', 'ground-model']) {
      const prompt = String(requests.find(request => request.model === model).messages[0].content);
      expect(prompt).toContain('"subject":"数学|物理|化学"');
      expect(prompt).toContain('student_work|teacher_note|correction|reference_answer|unknown');
      expect(prompt).toContain('regionId');
      expect(prompt).toContain('uncertainties');
      expect(prompt).toContain('cleanForPrint');
      expect(prompt).toContain('Unicode数学文本');
      expect(prompt).toContain('不得使用代码围栏或$包围的LaTeX');
    }
  });

  it('rejects dollar-delimited LaTeX that the native text renderer cannot display as intended', async () => {
    mode = 'bad-question-format'; requests.length = 0; const attempts: VisionAttempt[] = [];
    await expect(make(attempts).recognizeQuestion(source, { number: '4', box: { x: 0, y: 0, width: 1, height: 1 }, selectionEvidence: 'unclear', partial: false }, { ...context, questionId: crypto.randomUUID() }))
      .rejects.toMatchObject({ code: 'invalid_output', stage: 'transcribe', retryable: false });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ stage: 'transcribe', error: { code: 'invalid_output' } });
  });

  it('preserves literal dollar currency amounts in a source-faithful Unicode question', async () => {
    mode = 'currency'; requests.length = 0;
    const result = await make([]).recognizeQuestion(source, { number: '4', box: { x: 0, y: 0, width: 1, height: 1 }, selectionEvidence: 'unclear', partial: false }, { ...context, questionId: crypto.randomUUID() });
    expect(result.evidence.questionText).toBe('一本书售价 $5，另一本售价 $10，一共多少？');
  });

  it.each([
    ['currency-english', 'Book A costs $5. Book B costs $10.'],
    ['currency-inline', '价格分别是$5和$10，求总价。'],
  ] as const)('preserves ordinary literal-dollar text for %s', async (failureMode, expected) => {
    mode = failureMode; requests.length = 0;
    const result = await make([]).recognizeQuestion(source, { number: '4', box: { x: 0, y: 0, width: 1, height: 1 }, selectionEvidence: 'unclear', partial: false }, { ...context, questionId: crypto.randomUUID() });
    expect(result.evidence.questionText).toBe(expected);
  });

  it('checkpoints valid evidence before verification and resumes that exact next stage without retranscription', async () => {
    mode = 'verify-auth'; requests.length = 0; const checkpoints: any[] = []; const attempts: VisionAttempt[] = [];
    const adapter = make(attempts); const candidate = { number: '4', box: { x: 0, y: 0, width: 1, height: 1 }, selectionEvidence: 'unclear' as const, partial: false };
    await expect(adapter.recognizeQuestion(source, candidate, { ...context, questionId: crypto.randomUUID(), checkpoint: checkpoint => { checkpoints.push(structuredClone(checkpoint)); } })).rejects.toMatchObject({ code: 'authentication', stage: 'verify' });
    expect(checkpoints.at(-1)).toMatchObject({ evidence: { questionText: '求 x 的值。' }, nextStage: 'verify', groundingPasses: 0 });
    mode = 'pass'; requests.length = 0;
    await adapter.recognizeQuestion(source, candidate, { ...context, questionId: crypto.randomUUID(), resumeCheckpoint: checkpoints.at(-1) });
    expect(requests.some(request => request.model === 'transcribe-model')).toBe(false);
    expect(requests.some(request => request.model === 'verify-model')).toBe(true);
  });

  it('checkpoints successful grounding before crop work so restart does not repeat the paid ground call', async () => {
    mode = 'ground-crop-fail'; requests.length = 0; const checkpoints: any[] = []; const attempts: VisionAttempt[] = []; const validSource = Buffer.from(source);
    const adapter = make(attempts); const candidate = { number: '4', box: { x: 0, y: 0, width: 1, height: 1 }, selectionEvidence: 'unclear' as const, partial: false };
    await expect(adapter.recognizeQuestion(source, candidate, { ...context, questionId: crypto.randomUUID(), checkpoint: checkpoint => { checkpoints.push(structuredClone(checkpoint)); } }))
      .rejects.toMatchObject({ code: 'invalid_output', stage: 'crop' });
    source = validSource;
    expect(requests.filter(request => request.model === 'ground-model')).toHaveLength(1);
    expect(checkpoints.at(-1)).toMatchObject({ nextStage: 'verify', groundingPasses: 1 });
    mode = 'pass'; requests.length = 0;
    await adapter.recognizeQuestion(source, candidate, { ...context, questionId: crypto.randomUUID(), resumeCheckpoint: checkpoints.at(-1) });
    expect(requests.some(request => request.model === 'ground-model')).toBe(false);
  });

  it.each(['invalid', 'truncated'] as const)('retains raw rejected provider output and usage for %s output', async failureMode => {
    mode = failureMode; requests.length = 0; const attempts: VisionAttempt[] = [];
    await expect(make(attempts).inventory(source, context)).rejects.toBeInstanceOf(MobileVisionError);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.responseRaw).toContain('prompt_tokens');
    expect(attempts[0]?.usage).toEqual({ prompt_tokens: 31, completion_tokens: 17 });
    expect(attempts[0]?.error?.code).toMatch(/invalid_output|output_truncated/);
  });

  it('classifies a well-formed schema rejection in the same durable per-call attempt record', async () => {
    mode = 'bad-schema'; requests.length = 0; const attempts: VisionAttempt[] = [];
    await expect(make(attempts).inventory(source, context)).rejects.toMatchObject({ code: 'invalid_output', retryable: false });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ responseRaw: expect.stringContaining('candidates'), error: { code: 'invalid_output' } });
  });

  it('caps inventory at 30 with an explicit capacity warning', async () => {
    mode = 'capacity'; const result = await make([]).inventory(source, context);
    expect(result.candidates).toHaveLength(30);
    expect(result.warnings.join('')).toContain('30');
  });

  it('redacts a configured key even if a provider echoes it in the response body', async () => {
    mode = 'echo-key'; const attempts: VisionAttempt[] = [];
    await make(attempts).inventory(source, context);
    expect(JSON.stringify(attempts)).not.toContain('synthetic-secret');
    expect(attempts[0]?.responseRaw).toContain('[REDACTED]');
  });

  it('bounds oversized provider output while retaining the rejected prefix for diagnosis', async () => {
    mode = 'oversized'; const attempts: VisionAttempt[] = [];
    await expect(make(attempts).inventory(source, context)).rejects.toMatchObject({ code: 'invalid_output', retryable: false });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.responseRaw?.length).toBe(2_000_000);
  });

  it('uses verification issues for at most two corrective grounding passes and retains every prior version', async () => {
    mode = 'ground'; requests.length = 0; const attempts: VisionAttempt[] = [];
    const result = await make(attempts).recognizeQuestion(source, { number: '4', box: { x: 0, y: 0, width: 1, height: 1 }, selectionEvidence: 'unclear', partial: false }, { ...context, questionId: crypto.randomUUID() });
    expect(result.verification.questionCropComplete).toBe(true);
    expect(requests.filter(request => request.model === 'ground-model')).toHaveLength(2);
    expect(requests.filter(request => request.model === 'verify-model')).toHaveLength(3);
    expect(JSON.stringify(requests.filter(request => request.model === 'ground-model')[0].messages)).toContain('题框缺少条件');
    expect(attempts.filter(attempt => attempt.stage === 'ground')).toHaveLength(2);
  });

  it('retries network, 429 and transient 5xx only up to three total attempts, while authentication stops immediately', async () => {
    const attempts: VisionAttempt[] = []; mode = 'transient'; transientCalls = 0; requests.length = 0;
    await expect(make(attempts).inventory(source, context)).resolves.toHaveProperty('candidates');
    expect(requests).toHaveLength(3); expect(attempts).toHaveLength(3);
    mode = 'auth'; requests.length = 0; attempts.length = 0;
    await expect(make(attempts).inventory(source, context)).rejects.toMatchObject({ code: 'authentication', retryable: false });
    expect(requests).toHaveLength(1); expect(attempts).toHaveLength(1);
  });
});
