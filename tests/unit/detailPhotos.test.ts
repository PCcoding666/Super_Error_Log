import { describe, expect, it } from 'vitest';
import { detailPhotos } from '../../src/web/detailPhotos.js';

describe('detailPhotos', () => {
  it('shows the uncropped source page for a legacy item with no material fragments', () => {
    expect(detailPhotos('itm_aaaaaaaaaaaaaaaa', 'legacy', [])).toEqual([
      { url: '/s/img/item/itm_aaaaaaaaaaaaaaaa?scope=page&s=big', fullUrl: '/s/img/item/itm_aaaaaaaaaaaaaaaa?scope=page', title: '原图' },
    ]);
  });

  it('shows each uploaded page once when question and diagram share a photo', () => {
    const photos = detailPhotos('itm_bbbbbbbbbbbbbbbb', 'material', [
      { assetId: 'page-a', role: 'question' },
      { assetId: 'page-a', role: 'diagram' },
      { assetId: 'page-b', role: 'diagram' },
      { assetId: 'page-a', role: 'student_work' },
    ]);
    expect(photos).toEqual([
      { url: '/s/materials/assets/page-a/image', fullUrl: '/s/materials/assets/page-a/image', title: '原图' },
      { url: '/s/materials/assets/page-b/image', fullUrl: '/s/materials/assets/page-b/image', title: '原图' },
    ]);
    expect(photos.every(photo => !photo.url.includes('/crop'))).toBe(true);
  });

  it('uses the only fragment page when the stem itself was not found', () => {
    expect(detailPhotos('itm_cccccccccccccccc', 'material', [{ assetId: 'work-page', role: 'student_work' }])).toEqual([
      { url: '/s/materials/assets/work-page/image', fullUrl: '/s/materials/assets/work-page/image', title: '原图' },
    ]);
  });

  it('keeps the legacy full-question crop only when a material item has no fragments', () => {
    expect(detailPhotos('itm_dddddddddddddddd', 'material', [])).toEqual([
      { url: '/s/img/item/itm_dddddddddddddddd?scope=full&s=big', fullUrl: '/s/img/item/itm_dddddddddddddddd?scope=full', title: '整题照片' },
    ]);
  });
});
