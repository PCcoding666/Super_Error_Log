import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChatClient } from '../../src/ai/chatClient.js';
import { StagedProvider } from '../../src/ai/stagedProvider.js';
import { validateEvidence } from '../../src/ai/evidence.js';

describe('真实 HTTP 边界上的阶段路由（合成响应，不是模型效果评测）', () => {
  let server: http.Server; let baseUrl = ''; let syntheticImageDir = ''; let syntheticImagePath = '';
  const requests: Record<string, unknown>[] = [];
  const question = { questionNumber: '13', box: { x: 0.1, y: 0.2, width: 0.8, height: 0.4 }, confidence: 0.9, selectionEvidence: 'marked_wrong' };
  beforeAll(async () => {
    syntheticImageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-layout-'));
    syntheticImagePath = path.join(syntheticImageDir, 'synthetic.png');
    await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toFile(syntheticImagePath);
    server = http.createServer(async (req, res) => {
      let text = ''; for await (const b of req) text += b;
      const body = JSON.parse(text); requests.push(body);
      res.setHeader('content-type', 'application/json');
      const layouts: Record<string, unknown> = {
        'layout-array': [question],
        'layout-wrapper': { questions: [question] },
        'layout-empty-array': [],
        'layout-malformed-array': [{ ...question, confidence: 'high' }],
        'layout-duplicate-array': [question, question],
        'layout-too-many-array': Array.from({ length: 31 }, (_, i) => ({ ...question, questionNumber: String(i + 1) })),
      };
      // 模型在 JSON 里把 \frac、\neq 只写了一个反斜杠：解析后成了换页符、换行符。
      if (body.model === 'explain-model') {
        res.end(JSON.stringify({ model: body.model, choices: [{ finish_reason: 'stop', message: { content: '{"answer":"$x = \\frac{1}{2}$","solution":"1. 因为 $a \\neq b$\\n2. 得解","mistake":"你把分母写反了。","cause":"计算","uncertain":null}' } }], usage: { prompt_tokens: 50, completion_tokens: 40, total_tokens: 90 } }));
        return;
      }
      const content = body.model === 'bad-output' ? '{oops' : JSON.stringify(body.model in layouts ? layouts[body.model] : { summary: '所用关系不符合倒数条件', possibleCause: '知识概念', confidence: .7,
        findings: [{ observationIds: ['o1'], explanation: '图中用了两根之和为零' }], clarificationQuestion: '你如何理解互为倒数？' });
      res.end(JSON.stringify({ model: body.model, choices: [{ finish_reason: body.model === 'truncated' ? 'length' : 'stop', message: { content } }], usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 } }));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  afterAll(() => { server.close(); fs.rmSync(syntheticImageDir, { recursive: true }); });
  const client = (model = 'diagnostic-model') => new ChatClient({ baseUrl, apiKey: 'synthetic-test-key', models: { diagnose: model }, timeoutMs: 1000, bailianOnly: false });
  const layoutProvider = (model: string) => new StagedProvider(new ChatClient({ baseUrl, apiKey: 'synthetic-test-key', models: { layout: model }, timeoutMs: 1000, bailianOnly: false }));
  const layoutInput = () => ({ assetId: 'synthetic', filename: 'synthetic.png', mime: 'image/png', storagePath: syntheticImagePath, contentHash: 'synthetic-only' });
  it('实际发送作答证据且诊断使用对应阶段模型，保留费用所需 usage', async () => {
    const provider = new StagedProvider(client());
    const evidence = validateEvidence({ version: 1, questionNumber: '13', questionText: '两根互为倒数', subject: '数学', chapter: '', knowledgeTags: ['根与系数'], questionType: '',
      questionRegion: { x: 0, y: 0, width: 1, height: 1 }, requiresDiagram: false, regions: [],
      observations: [{ id: 'o1', kind: 'student_work', text: 'x1+x2=0，m=1', regionId: null, confidence: .8 }], uncertainties: [] });
    const result = await provider.diagnose(evidence);
    expect(result.value.possibleCause).toBe('知识概念');
    expect(result.run.promptTokens).toBe(120);
    expect(result.run.completionTokens).toBe(60);
    expect(requests.at(-1)?.model).toBe('diagnostic-model');
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('x1+x2=0，m=1');
  });
  it('详情页解答走 explain 阶段模型，只发识别出的文字，修回 JSON 吃掉的 LaTeX 反斜杠', async () => {
    const provider = new StagedProvider(new ChatClient({ baseUrl, apiKey: 'synthetic-test-key', models: { explain: 'explain-model' }, timeoutMs: 1000, bailianOnly: false }));
    const result = await provider.explainItem({ questionNumber: '3', questionText: '解方程 2x = 1', subject: '数学', chapter: '', knowledgeTags: [], questionType: '', requiresDiagram: false,
      observations: [{ id: 'o1', kind: 'student_work', text: 'x = 2', regionId: null, confidence: .9 }], uncertainties: [] });
    expect(result.value).toEqual({ answer: '$x = \\frac{1}{2}$', solution: '1. 因为 $a \\neq b$\n2. 得解', mistake: '你把分母写反了。', cause: '计算', uncertain: null });
    expect(result.run).toMatchObject({ stage: 'explain', model: 'explain-model', promptVersion: 'item-explain-v1' });
    const sent = JSON.stringify(requests.at(-1)?.messages);
    expect(sent).toContain('x = 2');
    expect(sent).not.toContain('image_url');
  });
  it('拒绝截断与非法 JSON，不将损坏响应当成有效证据', async () => {
    await expect(client('truncated').call('diagnose', [])).rejects.toMatchObject({ kind: 'invalid_json' });
    await expect(client('bad-output').call('diagnose', [])).rejects.toMatchObject({ kind: 'invalid_json' });
  });
  it('缺少配置或百炼模式指向其他域名时不发送任何请求', async () => {
    const count = requests.length;
    await expect(new ChatClient({ baseUrl, apiKey: '', models: { diagnose: 'x' }, timeoutMs: 100, bailianOnly: false }).call('diagnose', [])).rejects.toThrow();
    await expect(new ChatClient({ baseUrl, apiKey: 'x', models: { diagnose: 'x' }, timeoutMs: 100, bailianOnly: true }).call('diagnose', [])).rejects.toThrow();
    expect(requests.length).toBe(count);
  });
  it('超出保守输入预算或远程图片不发送请求', async () => {
    const count = requests.length;
    await expect(client().call('diagnose', [{ role: 'user', content: 'a'.repeat(100_001) }])).rejects.toThrow('输入');
    await expect(client().call('diagnose', [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/private.jpg' } }] }])).rejects.toThrow('图片');
    expect(requests.length).toBe(count);
  });
  it('布局阶段接受顶层题目数组并保留原值与运行元数据', async () => {
    const result = await layoutProvider('layout-array').layout(layoutInput());
    expect(result.value).toEqual({ questions: [question] });
    expect(result.run).toMatchObject({ stage: 'layout', model: 'layout-array', promptTokens: 120, completionTokens: 60 });
  });
  it('布局阶段仍接受文档化 questions 包装', async () => {
    await expect(layoutProvider('layout-wrapper').layout(layoutInput())).resolves.toMatchObject({ value: { questions: [question] } });
  });
  it('布局阶段将顶层空数组规范化为空 questions 包装', async () => {
    const result = await layoutProvider('layout-empty-array').layout(layoutInput());
    expect(result.value).toEqual({ questions: [] });
    const sentMessages = requests.at(-1)?.messages as Array<{ content: unknown }>;
    expect(sentMessages[0]?.content).toContain('{"questions":[]}');
  });
  it.each(['layout-malformed-array', 'layout-duplicate-array', 'layout-too-many-array'])('数组形式仍拒绝畸形题目、重复题号或超过30题：%s', async model => {
    await expect(layoutProvider(model).layout(layoutInput())).rejects.toMatchObject({ kind: 'invalid_json' });
  });
});
