import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { renderDisplayJpeg } from '../../src/web/images.js';
import { originalImageUrl, withDisplaySize } from '../../src/web/materialImageUrls.js';
import { displayImageCacheAllowed } from '../../src/studentHost/displayImageCache.js';
import { assetImageUrl, cropVersion, fragmentCropUrl, imageCacheControl } from '../../src/materials/displayDerivatives.js';
import type { Fragment } from '../../src/materials/contracts.js';

const fragment = {
  assetId: 'mas_a', fragmentId: 'mfr_a', revision: 2, sourceHash: 'ab'.repeat(32),
  box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, role: 'question', text: '', number: '1', subpart: null,
  page: 1, order: 0, requiresDiagram: false, check: 'passed', uncertainties: [],
} satisfies Fragment;

describe('display image urls', () => {
  it('keeps a size on the review image and drops it for the original', () => {
    expect(withDisplaySize('/s/materials/fragments/mfr_a/crop?revision=1&s=list&v=abc', 'big'))
      .toBe('/s/materials/fragments/mfr_a/crop?revision=1&s=big&v=abc');
    expect(originalImageUrl('/s/materials/assets/mas_a/image?v=abc&s=big')).toBe('/s/materials/assets/mas_a/image');
    expect(withDisplaySize(null, 'big')).toBeNull();
  });

  it('addresses page and crop derivatives with a hash and a size', () => {
    expect(assetImageUrl('mas_a', fragment.sourceHash, 'thumb')).toBe(`/s/materials/assets/mas_a/image?v=${fragment.sourceHash}&s=thumb`);
    expect(assetImageUrl('mas_a', fragment.sourceHash, null)).toBe('/s/materials/assets/mas_a/image');
    const crop = fragmentCropUrl(fragment, 'big');
    expect(crop).toContain('/s/materials/fragments/mfr_a/crop?');
    expect(crop).toContain('revision=2');
    expect(crop).toContain(`v=${cropVersion(fragment)}`);
    expect(crop).toContain('s=big');
    expect(fragmentCropUrl(fragment, 'list', 'preview')).toContain('/s/api/intake/candidates/mfr_a/crop?');
  });
});

describe('display image cache', () => {
  const hash = 'ab'.repeat(32);
  it('allows only a private immutable display JPEG', () => {
    expect(displayImageCacheAllowed('/materials/assets/mas_a/image', { s: 'big', v: hash }, 'private, max-age=31536000, immutable')).toBe(true);
    expect(displayImageCacheAllowed('/api/intake/candidates/mfr_a/crop', { s: 'list', v: hash }, 'private, max-age=60, immutable')).toBe(true);
    expect(displayImageCacheAllowed('/materials/assets/mas_a/image', { s: 'big', v: hash }, 'private, no-store')).toBe(false);
    expect(displayImageCacheAllowed('/materials/assets/mas_a/image', { v: hash }, 'private, max-age=31536000, immutable')).toBe(false);
    expect(displayImageCacheAllowed('/materials/assets/mas_a/image', { s: 'big' }, 'private, max-age=31536000, immutable')).toBe(false);
    expect(displayImageCacheAllowed('/materials', { s: 'big', v: hash }, 'private, max-age=31536000, immutable')).toBe(false);
    expect(imageCacheControl(hash, hash, true)).toBe('private, max-age=31536000, immutable');
    expect(imageCacheControl('other', hash, true)).toBe('private, no-store');
    expect(imageCacheControl(hash, hash, false)).toBe('private, no-store');
  });
});

describe('renderDisplayJpeg', () => {
  it('shrinks a wide page and leaves a small jpeg unchanged', async () => {
    const wide = await sharp({ create: { width: 2000, height: 800, channels: 3, background: '#369' } }).jpeg().toBuffer();
    const big = await renderDisplayJpeg(wide, 'big');
    const thumb = await renderDisplayJpeg(wide, 'thumb');
    expect((await sharp(big).metadata()).width).toBeLessThanOrEqual(1088);
    expect(Math.max((await sharp(thumb).metadata()).width ?? 0, (await sharp(thumb).metadata()).height ?? 0)).toBeLessThanOrEqual(168);
    expect(big.length).toBeLessThan(wide.length);
    const small = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    expect(await renderDisplayJpeg(small, 'big')).toBe(small);
  });
});
