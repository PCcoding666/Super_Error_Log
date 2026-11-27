import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CapturePage, PhotosPage } from '../../src/web/views/photos.js';
import type { PhotoView } from '../../src/web/state.js';

const photo = (fields: Partial<PhotoView> = {}): PhotoView => ({
  number: 1, jobId: 'photo-1', registeredAt: '2026-10-10T03:00:00Z', job: null,
  state: null, failure: null, pickDone: false, dismissed: false, itemCount: 0, unselectedCount: 0, ...fields,
});

describe('补充照片的反馈只以实际入库数量为准', () => {
  const render = (photos: PhotoView[], refresh = false) => renderToStaticMarkup(PhotosPage({
    photos, refresh, itemCount: photos.reduce((n, p) => n + p.itemCount, 0),
    afterWeek: true, newSince: '2026-10-10T02:00:00Z', bar: { caption: '', primary: null, secondary: [] },
  }));

  it('上传成功、识别未完成：拍照页和进度页说明仍在找题', () => {
    const photos = [photo({ state: 'finding' })];
    for (const html of [render(photos, true), renderToStaticMarkup(CapturePage({ photos, next: null, caption: '' }))]) {
      expect(html).toContain('照片已收到，正在找题。');
      expect(html).not.toMatch(/已新增 \d+ 道错题|已保存到错题本/);
    }
  });

  it('识别已结束但未入库（重复上传等）不能报新增成功', () => {
    const html = render([photo()]);
    expect(html).not.toMatch(/已新增 \d+ 道错题|已保存到错题本/);
  });

  it('只统计练习生成后实际入库的新题，并提供查看和回首页入口', () => {
    const html = render([
      photo({ registeredAt: '2026-10-10T01:00:00Z', itemCount: 5 }),
      photo({ number: 2, jobId: 'photo-2', itemCount: 2 }),
    ]);
    expect(html).toContain('已新增 2 道错题');
    expect(html).toContain('已保存到错题本，这次补充不会改变之前的练习纸。');
    expect(html).toContain('href="/s/items"');
    expect(html.replace(/<[^>]+>/g, '')).toContain('查看错题本');
    expect(html).toMatch(/href="\/s\/"[^>]*>返回错题本/);
  });
});
