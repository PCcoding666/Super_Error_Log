import http from 'node:http';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChatClient } from '../../src/ai/chatClient.js';
import * as engine from '../../src/ai/cropAuditor.js';
import { validateEvidence } from '../../src/ai/evidence.js';
import { humanResolution } from '../../src/ai/cropResolution.js';

describe('裁图自动核对的真实 HTTP 边界（合成模型响应）', () => {
  let server: http.Server; let baseUrl: string; let source: Buffer;
  let mode = 'missing'; const requests: any[] = [];
  const evidence = () => validateEvidence({ version: 1, questionNumber: '9', questionText: '已知2x−1，求B。',
    subject: '数学', chapter: '', knowledgeTags: [], questionType: '', requiresDiagram: false,
    questionRegion: { x: .1, y: .1, width: .8, height: .25 }, regions: [], observations: [], uncertainties: [] });
  beforeAll(async () => {
    source = await sharp({ create: { width: 400, height: 500, channels: 3, background: 'white' } }).png().toBuffer();
    server = http.createServer(async (req, res) => {
      let body = ''; for await (const b of req) body += b;
      const request = JSON.parse(body); requests.push(request);
      const targetKind = JSON.parse(request.messages[1].content[0].text).kind;
      if (mode === 'timeout') { res.writeHead(429).end(); return; }
      const inventory = { questionNumber: mode === 'wrong-question' ? '12' : '9', sourceStatus: 'readable', referenceText: '已知2x−1，求B。', uncertainties: [], items: [
        { id: 'c1', category: targetKind === 'question' ? 'condition' : targetKind === 'diagram' ? 'diagram' : 'mark', description: '包括换行1的完整2x−1' },
        { id: 'c2', category: targetKind === 'question' ? 'request' : targetKind === 'diagram' ? 'diagram' : 'mark', description: '求B对应的数' }] };
      const comparison = { checks: [{ id: 'c1', visibility: mode === 'missing' ? 'missing' : 'present', note: '核对换行的1' },
        { id: 'c2', visibility: 'present', note: '求B的要求可见' }], unexpectedMissing: [], uncertainties: [], boundary: 'clear',
        purity: { status: mode === 'dirty' ? 'contaminated' : 'clean', issues: mode === 'dirty' ? ['上一题文字'] : [] },
        textFidelity: mode === 'wrong-text' ? 'mismatch' : 'match', textNote: '独立核对题干', coveredDiagramIds: [], verdict: 'pass' };
      const value = request.model === 'inventory-fixture' ? inventory : mode === 'bad-schema' ? { checks: [] } : comparison;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: request.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
        usage: { prompt_tokens: 123, completion_tokens: 45 } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  afterAll(() => server.close());
  const auditor = () => new engine.CropAuditor(new ChatClient({ baseUrl, apiKey: 'synthetic-only', bailianOnly: false,
    models: { crop_inventory: 'inventory-fixture', crop_verify: 'verify-fixture' }, timeoutMs: 2000 }));
  it('counts backup HTTP in the 24-call cap and resumes every budget-blocked target', async () => {
    mode='pass';requests.length=0;
    const e=evidence();e.regions=Array.from({length:12},(_,i)=>({id:`d${i}`,kind:'diagram' as const,box:{x:.1,y:.1,width:.2,height:.1},confidence:1,cleanForPrint:false}));
    const realFetch=globalThis.fetch;
    const fetcher=vi.fn(async(url:string,init?:RequestInit)=>new URL(url).hostname.startsWith('token-plan.')?new Response('{}',{status:503}):realFetch(baseUrl+'/chat/completions',init));
    vi.stubEnv('SEL_TOKEN_PLAN_API_KEY','synthetic-plan');vi.stubGlobal('fetch',fetcher);
    try{
      const subject=new engine.CropAuditor(new ChatClient({baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',apiKey:'synthetic-only',bailianOnly:true,models:{crop_inventory:'inventory-fixture',crop_verify:'verify-fixture'},timeoutMs:2000}));
      const first=await subject.check(source,e);
      expect(fetcher).toHaveBeenCalledTimes(24);expect(first.targets.filter(t=>t.technicalStatus==='completed')).toHaveLength(6);
      expect(first.targets.filter(t=>t.technicalStatus==='not_checked')).toHaveLength(7);
      const second=await subject.check(source,e,first);
      expect(fetcher).toHaveBeenCalledTimes(48);expect(second.targets.filter(t=>t.technicalStatus==='completed')).toHaveLength(12);
      const third=await subject.check(source,e,second);
      expect(fetcher).toHaveBeenCalledTimes(52);expect(third.targets.every(t=>t.technicalStatus==='completed')).toBe(true);
    }finally{vi.unstubAllGlobals();vi.unstubAllEnvs();}
  });
  it('原图独立建清单，再发送原图、上下文与裁图；成功响应不能掩盖题干缺失', async () => {
    mode = 'missing'; requests.length = 0;
    const report = await auditor().check(source, evidence());
    expect(report.targets[0]).toMatchObject({ technicalStatus: 'completed', completeness: 'missing' });
    expect(report.sourceHash).toBe(crypto.createHash('sha256').update(source).digest('hex'));
    expect(requests).toHaveLength(2);
    const firstText = JSON.stringify(requests[0].messages);
    expect(firstText).not.toContain('questionRegion');
    expect(firstText).not.toContain('已知2x−1，求B。'); // no candidate transcription to bias source inventory
    const images = requests[1].messages[1].content.filter((p: any) => p.type === 'image_url');
    expect(images).toHaveLength(3);
    expect(images[0].image_url.url).not.toBe(images[2].image_url.url);
    expect(report.targets[0]!.runs.map(r => r.promptTokens)).toEqual([123, 123]);
    expect(() => engine.assertCropAudit(evidence(), report, report.sourceHash)).toThrow(/完整/);
  });
  it('原图或题干改变使旧检查失效，单独人工勾选打印纯净不改变证据指纹', async () => {
    mode = 'pass'; const e = evidence(); const report = await auditor().check(source, e);
    expect(() => engine.assertCropAudit(e, report, report.sourceHash)).not.toThrow();
    expect(() => engine.assertCropAudit({ ...e, questionText: '漏掉条件' }, report, report.sourceHash)).toThrow(/过期/);
    expect(() => engine.assertCropAudit(e, report, 'changed-source')).toThrow(/过期/);
    expect(() => engine.assertCropAudit(e, null, report.sourceHash)).toThrow(/检查/);
  });
  it('不完整JSON保留已发生调用的usage，但不伪造完整性通过', async () => {
    mode = 'bad-schema'; const report = await auditor().check(source, evidence());
    expect(report.targets[0]).toMatchObject({ technicalStatus: 'failed', completeness: 'uncertain' });
    expect(report.targets[0]!.runs).toHaveLength(2);
    expect(report.targets[0]!.responseHashes).toHaveLength(2);
    expect(report.targets[0]!.responseHashes[1]).toMatch(/^[a-f0-9]{64}$/);
    expect(report.targets[0]!.failurePhase).toBe('comparison_schema');
    expect(() => engine.assertCropAudit(evidence(), report, report.sourceHash)).toThrow();
  });
  it('服务失败不重试，不允许未执行的检查默认为通过', async () => {
    mode = 'timeout'; requests.length = 0; const report = await auditor().check(source, evidence());
    expect(requests).toHaveLength(1);
    expect(report.targets[0]).toMatchObject({ technicalStatus: 'failed', completeness: 'uncertain' });
    expect(JSON.stringify(report)).not.toContain('synthetic-only');
  });
  it('题干裁图完整但文本转写不一致时仍不放行', async () => {
    mode = 'wrong-text'; const e = evidence(); const report = await auditor().check(source, e);
    expect(report.targets[0]!.completeness).toBe('pass');
    expect(() => engine.assertCropAudit(e, report, report.sourceHash)).toThrow(/转写/);
  });
  it('完整题目审阅框允许邻题上下文，但必要图示必须纯净', async () => {
    mode = 'dirty'; const e = evidence(); const report = await auditor().check(source, e);
    expect(() => engine.assertCropAudit(e, report, report.sourceHash)).not.toThrow();
    e.requiresDiagram = true;
    e.regions = [{ id: 'd', kind: 'diagram', box: { x: .3, y: .1, width: .2, height: .1 }, confidence: 1, cleanForPrint: false }];
    const withDiagram = await auditor().check(source, e);
    expect(() => engine.assertCropAudit(e, withDiagram, withDiagram.sourceHash)).toThrow(/纯净/);
    const before = engine.evidenceFingerprint(e); e.regions[0]!.cleanForPrint = true;
    expect(engine.evidenceFingerprint(e)).toBe(before);
  });
  it('没有来源区域的学生作答不能绕过完整性检查', async () => {
    mode = 'pass'; const e = evidence(); e.observations.push({ id: 'o1', kind: 'student_work', text: '1/2', regionId: null, confidence: 1 });
    const report = await auditor().check(source, e);
    expect(() => engine.assertCropAudit(e, report, report.sourceHash)).toThrow(/定位/);
  });
  it('清单跑到另一道题时在源清单阶段拦截，不用错题清单继续付费校验', async () => {
    mode = 'wrong-question'; requests.length = 0;
    const report = await auditor().check(source, evidence());
    expect(report.targets[0]).toMatchObject({ technicalStatus: 'failed', completeness: 'uncertain' });
    expect(requests).toHaveLength(1);
    expect(report.targets[0]!.failurePhase).toBe('inventory_identity');
  });
  it('学生作答框混入订正时不放行，不能只检查图示纯净度', async () => {
    mode = 'dirty'; const e = evidence();
    e.regions = [{ id: 's1', kind: 'student_work', box: { x: .1, y: .1, width: .2, height: .1 }, confidence: 1, cleanForPrint: false }];
    e.observations = [{ id: 'o1', kind: 'student_work', text: '1/2', regionId: 's1', confidence: 1 }];
    const report = await auditor().check(source, e);
    expect(() => engine.assertCropAudit(e, report, report.sourceHash)).toThrow(/纯净/);
  });
  it('正常12MP大幅题目能完成比较，不因重复全幅图片超过输入预算而失败', async () => {
    mode = 'pass'; requests.length = 0;
    const large = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: 'white' } }).jpeg().toBuffer();
    const e = evidence(); e.questionRegion = { x: 0, y: 0, width: 1, height: 1 };
    const report = await auditor().check(large, e);
    expect(report.targets[0]!.technicalStatus).toBe('completed');
    expect(requests).toHaveLength(2);
  });
  it('超过一轮上限时下一轮只继续未检查区域，不重复花费首批24次调用', async () => {
    mode = 'pass'; const e = evidence();
    e.regions = Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, kind: 'diagram' as const, box: { x: .1, y: .1, width: .2, height: .1 }, confidence: 1, cleanForPrint: false }));
    requests.length = 0; const first = await auditor().check(source, e);
    expect(first.targets.at(-1)!.technicalStatus).toBe('not_checked'); expect(requests).toHaveLength(24);
    requests.length = 0; const second = await auditor().check(source, e, first);
    expect(second.targets.every(t => t.technicalStatus === 'completed')).toBe(true); expect(requests).toHaveLength(2);
  });
  it('原题需要图A和图B时，只留下通过检查的图A仍不能打印', async () => {
    mode = 'pass'; const e = evidence(); e.requiresDiagram = true;
    e.regions = [{ id: 'a', kind: 'diagram', box: { x: .1, y: .1, width: .2, height: .1 }, confidence: 1, cleanForPrint: true }];
    const report = await auditor().check(source, e);
    const q = report.targets[0]!.assessment!;
    q.inventory.items.push({ id: 'd1', category: 'diagram', description: '图A：数轴' }, { id: 'd2', category: 'diagram', description: '图B：几何图' });
    q.comparison.checks.push({ id: 'd1', visibility: 'present', note: '整题框有图A' }, { id: 'd2', visibility: 'present', note: '整题框有图B' });
    Object.assign(report.targets[1]!.assessment!.comparison, { coveredDiagramIds: ['d1'] });
    expect(() => engine.assertCropAudit(e, report, report.sourceHash)).toThrow(/图示.*覆盖/);
  });
  it('整题原图清单失败时，人工自由文本不能绕过多图覆盖检查', async () => {
    mode = 'pass'; const e = evidence(); e.requiresDiagram = true;
    e.regions = [{ id: 'onlyA', kind: 'diagram', box: { x: .1, y: .1, width: .2, height: .1 }, confidence: 1, cleanForPrint: true }];
    const report = await auditor().check(source, e); const q = report.targets[0]!;
    Object.assign(q, { technicalStatus: 'failed', assessment: null, inventory: null });
    const decision = { modelCheckHash: engine.cropCheckHash(q), requiredElements: ['图A', '图B'],
      coveredDiagramIds: [], notes: '已逐项核对原始页面和全部裁图', sourceCompared: true, complete: true, textMatches: true, pure: true };
    expect(() => humanResolution(q, report, engine.cropCheckHash(q), decision)).toThrow(/整题.*清单/);
  });
});
