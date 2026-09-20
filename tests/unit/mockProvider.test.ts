import { describe, expect, it } from 'vitest';
import { AiError } from '../../src/ai/errors.js';
import { MockAiProvider } from '../../src/ai/mockProvider.js';

const base = {
  assetId: 'a1',
  filename: 'random-photo.png',
  mime: 'image/png',
  storagePath: '/tmp/x.png',
  contentHash: 'abc123def456',
};

describe('MockAiProvider', () => {
  it('同一输入输出稳定（deterministic）', async () => {
    const p = new MockAiProvider('/nonexistent/manifest.json', '');
    const r1 = await p.extractItems(base);
    const p2 = new MockAiProvider('/nonexistent/manifest.json', '');
    const r2 = await p2.extractItems(base);
    expect(r1).toEqual(r2);
    expect(r1.items.length).toBeGreaterThanOrEqual(1);
  });

  it('不同哈希输出不同', async () => {
    const p = new MockAiProvider('/nonexistent/manifest.json', '');
    const r1 = await p.extractItems(base);
    const r2 = await p.extractItems({ ...base, contentHash: 'ffff9999' });
    expect(JSON.stringify(r1)).not.toBe(JSON.stringify(r2));
  });

  it('故障注入：timeout', async () => {
    const p = new MockAiProvider('/nonexistent/manifest.json', 'timeout');
    await expect(p.extractItems(base)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('故障注入：invalid_json', async () => {
    const p = new MockAiProvider('/nonexistent/manifest.json', 'invalid_json');
    await expect(p.extractItems(base)).rejects.toBeInstanceOf(AiError);
  });

  it('反思建议：含做题状态、确定性输出、高低置信两档都存在', async () => {
    const p = new MockAiProvider('/nonexistent/manifest.json', '');
    const ids = Array.from({ length: 12 }, (_, i) => `item-${i}`);
    const suggestions = [];
    for (const itemId of ids) {
      const s = await p.suggestFields({ itemId, textExcerpt: '摘要', subject: '数学' });
      expect(s.attemptState).toBeDefined();
      expect(s.possibleCause).toBeDefined();
      expect(s.reviewValue).toBeDefined();
      suggestions.push(s);
    }
    // 确定性：同一 itemId 两次结果一致
    const again = await p.suggestFields({ itemId: 'item-0', textExcerpt: '摘要', subject: '数学' });
    expect(again).toEqual(suggestions[0]);
    // 高置信（可一键采纳）与低置信（仍需逐项判断）两档都要出现
    const adoptable = suggestions.filter(
      (s) => s.attemptState!.confidence >= 0.6 && s.possibleCause!.confidence >= 0.6 && s.reviewValue!.confidence >= 0.6,
    );
    expect(adoptable.length).toBeGreaterThan(0);
    expect(adoptable.length).toBeLessThan(suggestions.length);
  });

  it('完成页匹配：文件名含短 ID → 高置信', async () => {
    const p = new MockAiProvider('/nonexistent/manifest.json', '');
    const r = await p.matchReturnSheet({
      imagePath: '/tmp/return_xxx.img',
      originalName: 'RET-M-03.png',
      contentHash: 'zzz',
      candidateShortIds: ['M-01', 'M-03'],
    });
    expect(r.shortId).toBe('M-03');
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  it('完成页匹配：无法识别 → 低置信走人工', async () => {
    const p = new MockAiProvider('/nonexistent/manifest.json', '');
    const r = await p.matchReturnSheet({
      imagePath: '/tmp/return_yyy.img',
      originalName: 'blur.png',
      contentHash: 'zzz',
      candidateShortIds: ['M-01', 'M-03'],
    });
    expect(r.confidence).toBeLessThan(0.8);
  });
});
