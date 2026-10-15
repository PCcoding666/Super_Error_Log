/**
 * F8 回归：openaiProvider 的 extract 输出必须过严格运行时校验，
 * 畸形数据抛 AiError('invalid_json') 进入重试/转人工流程，而不是脏数据入库。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AiError } from '../../src/ai/errors.js';
import { OpenAiCompatibleProvider } from '../../src/ai/openaiProvider.js';
import { validateExtractItems } from '../../src/ai/validate.js';

const validItem = {
  itemIndex: 0,
  textExcerpt: '解方程 x²-5x+6=0',
  subject: '数学',
  chapter: '一元二次方程',
  knowledgeTags: ['因式分解'],
  questionType: '计算题',
  hasTeacherNote: true,
  hasAnswer: false,
  confidence: 0.92,
  fieldConfidence: { subject: 0.9, knowledgeTags: 0.7 },
};

describe('validateExtractItems', () => {
  it('合法数据通过并保留字段', () => {
    const items = validateExtractItems({ items: [validItem] });
    expect(items).toHaveLength(1);
    expect(items[0]!.textExcerpt).toBe(validItem.textExcerpt);
    expect(items[0]!.knowledgeTags).toEqual(['因式分解']);
    expect(items[0]!.confidence).toBe(0.92);
    expect(items[0]!.hasTeacherNote).toBe(true);
  });

  it('缺少 items 数组 → invalid_json', () => {
    expect(() => validateExtractItems({})).toThrowError(AiError);
    expect(() => validateExtractItems(null)).toThrowError(AiError);
  });

  it.each([
    ['itemIndex 非整数', { ...validItem, itemIndex: '零' }],
    ['itemIndex 为负', { ...validItem, itemIndex: -1 }],
    ['textExcerpt 为空', { ...validItem, textExcerpt: '' }],
    ['knowledgeTags 不是数组', { ...validItem, knowledgeTags: '因式分解' }],
    ['knowledgeTags 含非字符串', { ...validItem, knowledgeTags: ['a', 1] }],
    ['confidence 越界', { ...validItem, confidence: 1.5 }],
    ['confidence 非数字', { ...validItem, confidence: '高' }],
    ['fieldConfidence 值越界', { ...validItem, fieldConfidence: { subject: 2 } }],
    ['fieldConfidence 是数组', { ...validItem, fieldConfidence: [0.9] }],
  ])('%s → invalid_json', (_name, badItem) => {
    try {
      validateExtractItems({ items: [badItem] });
      expect.unreachable('应当抛出 AiError');
    } catch (e) {
      expect(e).toBeInstanceOf(AiError);
      expect((e as AiError).kind).toBe('invalid_json');
    }
  });

  it('可选字段缺失时安全降级（hasTeacherNote/hasAnswer=false，fieldConfidence={}）', () => {
    const minimal = {
      itemIndex: 1,
      textExcerpt: '计算 3+4',
      knowledgeTags: [],
      confidence: 0.5,
    };
    const items = validateExtractItems({ items: [minimal] });
    expect(items[0]!.hasTeacherNote).toBe(false);
    expect(items[0]!.hasAnswer).toBe(false);
    expect(items[0]!.fieldConfidence).toEqual({});
    expect(items[0]!.subject).toBeUndefined();
  });
});

describe('OpenAiCompatibleProvider.extractItems 校验（不依赖网络）', () => {
  function providerReturning(payload: unknown): OpenAiCompatibleProvider {
    const p = new OpenAiCompatibleProvider();
    (p as unknown as { chat: () => Promise<unknown> }).chat = async () => payload;
    return p;
  }
  const input = () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sel-ai-')), 'q.png');
    fs.writeFileSync(tmp, Buffer.from('fake-image'));
    return { assetId: 'a1', filename: 'q.png', mime: 'image/png', storagePath: tmp, contentHash: 'h' };
  };

  it('畸形输出 → AiError invalid_json', async () => {
    const p = providerReturning({ items: [{ itemIndex: '零', textExcerpt: 1 }] });
    await expect(p.extractItems(input())).rejects.toMatchObject({ kind: 'invalid_json' });
  });

  it('合法输出 → 正常返回', async () => {
    const p = providerReturning({ items: [validItem] });
    const r = await p.extractItems(input());
    expect(r.items).toHaveLength(1);
  });
});
