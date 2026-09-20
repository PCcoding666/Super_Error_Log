import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BatchDetailPage } from '../../src/views/batches.js';
import { HomePage, type HomeData } from '../../src/views/home.js';

const batchBase = { id: 'b-123456', status: 'processing', total_files: 19, done_files: 3, failed_files: 0, created_at: '2026-09-20T00:00:00Z' };
const homeBase: HomeData = {
  nickname: '测试', aiMode: 'mock', aiDegraded: false, pendingCorrection: 0, pendingReflection: 0,
  eligibleCount: 0, activePacket: null,
  recentBatch: { id: 'b-123456', status: 'processing', total: 19, done: 3, failed: 0 },
};

describe('处理中页面自动刷新（SSR 无 hydration，meta refresh）', () => {
  it('批次详情页：processing 时输出 3 秒 meta refresh', () => {
    const html = renderToStaticMarkup(
      BatchDetailPage({ role: 'student', batch: batchBase, assets: [], items: [] }),
    );
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain('content="3"');
  });

  it('批次详情页：非 processing（done/failed/needs_attention）不自动刷新', () => {
    for (const status of ['done', 'failed', 'needs_attention', 'partial']) {
      const html = renderToStaticMarkup(
        BatchDetailPage({ role: 'student', batch: { ...batchBase, status }, assets: [], items: [] }),
      );
      expect(html).not.toContain('http-equiv="refresh"');
    }
  });

  it('首页：最近批次处理中时也自动刷新，处理完不刷新', () => {
    const processing = renderToStaticMarkup(HomePage({ role: 'student', data: homeBase }));
    expect(processing).toContain('http-equiv="refresh"');
    const done = renderToStaticMarkup(HomePage({ role: 'student', data: { ...homeBase, recentBatch: { ...homeBase.recentBatch!, status: 'done' } } }));
    expect(done).not.toContain('http-equiv="refresh"');
    const noBatch = renderToStaticMarkup(HomePage({ role: 'student', data: { ...homeBase, recentBatch: null } }));
    expect(noBatch).not.toContain('http-equiv="refresh"');
  });
});
