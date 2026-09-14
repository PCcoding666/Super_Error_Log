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
