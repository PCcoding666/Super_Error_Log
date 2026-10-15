import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TodayPage } from '../../src/web/views/today.js';
import { CapturePage, PhotosPage } from '../../src/web/views/photos.js';
import { make, makeInput, practice } from '../../src/web/weekPlan.js';
import type { PhotoView, TodayState } from '../../src/web/state.js';

const today = new Date('2026-10-10T04:00:00Z');
const week = '2026-W41';
const photo = (fields: Partial<PhotoView> = {}): PhotoView => ({
  number: 1, jobId: 'photo-1', registeredAt: '2026-10-10T03:00:00Z', job: null,
  state: null, failure: null, pickDone: false, dismissed: false, itemCount: 0, unselectedCount: 0, ...fields,
});

describe('首页补充错题入口不依赖当前学习步骤', () => {
  const cases = [
    { name: '未上传', days: null, photos: [], generated: false, stage: 'weekendA' },
    { name: '正在整理', days: null, photos: [{ number: 1, taskID: 'p', jobID: 'p', state: 'finding' as const }], generated: false, stage: 'weekendA' },
    { name: '已选题等待复盘或打印', days: 0, photos: [], generated: false, stage: 'weekendA' },
    { name: '练习纸已准备好', days: 0, photos: [], generated: true, stage: 'done' },
    { name: '周中等待做题', days: 3, photos: [], generated: true, stage: 'midweek' },
    { name: '等待录结果', days: 7, photos: [], generated: true, stage: 'weekendB' },
  ];
  for (const c of cases) it(c.name, () => {
    const practices = c.days === null ? [] : [practice({
      id: 'packet', week, itemCount: 5, createdAt: today,
      generatedAt: c.generated ? new Date(today.getTime() - c.days * 86400000) : null, answered: 0,
    })];
    const plan = make(makeInput({ today, weekKey: week, practices, localPhotos: c.photos }));
    expect(plan.stage).toBe(c.stage);
    const state: TodayState = {
      plan, practices, photos: [], latestDetail: null, preparingPrintID: null, week: { week, photos: [], items: [], backlog: [] },
      marks: { pickDone: new Set(), dismissed: new Set() }, skips: { steps: new Set(), passedItems: new Set() },
    };
    const html = renderToStaticMarkup(TodayPage({ state, practiceSlot: '周三', showInstallHint: true }));
    expect(html).toMatch(/<a[^>]+href="\/s\/capture"[^>]+data-testid="today-add-mistakes"[^>]*>＋补充错题<\/a>/);
    expect(html).toContain('拍照或从相册选图，随时添加。');
    expect(html.indexOf('data-testid="today-add-mistakes"')).toBeLessThan(html.indexOf('data-testid="today-items"'));
    if (c.stage === 'done') {
      expect(html.replace(/<[^>]+>/g, '')).toContain('这一份练习纸已准备好');
      expect(html).not.toContain('这周的事做完了');
    }
  });
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
    expect(html.replace(/<[^>]+>/g, '')).toContain('查看这周的错题');
    expect(html).toMatch(/href="\/s\/"[^>]*>回到今天/);
  });
});
