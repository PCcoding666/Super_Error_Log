import type { ItemImage } from './apiTypes.js';

/**
 * 详情页给学生看的照片是上传的整页，不是模型裁框。
 * 题干文字另存在识别结果里，框切掉印刷题干时文字仍可以是完整的。
 * 同一张原图上的题目和图形只出一张，避免整页重复。
 * 没有材料片段的旧流程题走 scope=page（未裁切的来源页）；材料题没有片段时仍退回整题裁图。
 */
export function detailPhotos(itemId: string, sourceKind: 'legacy' | 'material', fragments: { assetId: string; role: string }[]): ItemImage[] {
  const stem = fragments.filter(fragment => fragment.role === 'question' || fragment.role === 'diagram');
  const shown = stem.length ? stem : fragments.slice(0, 1);
  const seen = new Set<string>();
  const photos: ItemImage[] = [];
  for (const fragment of shown) {
    if (seen.has(fragment.assetId)) continue;
    seen.add(fragment.assetId);
    const url = `/s/materials/assets/${fragment.assetId}/image`;
    photos.push({ url, fullUrl: url, title: '原图' });
  }
  if (photos.length) return photos;
  if (sourceKind === 'legacy') {
    const url = `/s/img/item/${itemId}?scope=page`;
    return [{ url: `${url}&s=big`, fullUrl: url, title: '原图' }];
  }
  return [{ url: `/s/img/item/${itemId}?scope=full&s=big`, fullUrl: `/s/img/item/${itemId}?scope=full`, title: '整题照片' }];
}
