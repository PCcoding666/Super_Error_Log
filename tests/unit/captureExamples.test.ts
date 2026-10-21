import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { CAPTURE_EXAMPLE_PAGE, CAPTURE_EXAMPLE_QUESTION } from '../../src/web/captureExamples.js';
import type { PhotoView } from '../../src/web/state.js';
import { CapturePage } from '../../src/web/views/photos.js';
import { MaterialCapturePage } from '../../src/web/views/materials.js';

const photo = (): PhotoView => ({
  number: 1, jobId: 'photo-1', registeredAt: '2026-10-10T03:00:00Z', job: null,
  state: null, failure: null, pickDone: false, dismissed: false, itemCount: 0, unselectedCount: 0,
});

describe('错题录入示例照片', () => {
  it('合成示例是小 JPEG；空页面展示，有照片后收起，不提阿里云或上传同意', async () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../../src/web/examples');
    for (const [file, asset] of [['capture-page.jpg', CAPTURE_EXAMPLE_PAGE], ['capture-question.jpg', CAPTURE_EXAMPLE_QUESTION]] as const) {
      expect(readFileSync(join(dir, file)).equals(asset.bytes)).toBe(true);
      expect(asset.bytes.length).toBeLessThan(40_000);
      expect(asset.path).toMatch(/^\/s\/assets\/capture-(page|question)\.[0-9a-f]{10}\.jpg$/);
      const meta = await sharp(asset.bytes).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBeGreaterThan(200);
      expect(meta.exif).toBeUndefined();
    }
    const empty = renderToStaticMarkup(CapturePage({ photos: [], next: null, caption: '' }));
    expect(empty).toContain('data-testid="capture-examples"');
    expect(empty).toContain('平放、拍全、光线均匀');
    expect(empty).toContain(CAPTURE_EXAMPLE_PAGE.path);
    expect(empty).toContain(CAPTURE_EXAMPLE_QUESTION.path);
    expect(empty).not.toContain('阿里云');
    expect(empty).not.toContain('上传前看一下');
    expect(empty).not.toContain('把卷子平放在桌上');
    expect(empty).not.toContain('/s/consent');
    const filled = renderToStaticMarkup(CapturePage({ photos: [photo()], next: null, caption: '' }));
    expect(filled).not.toContain('capture-examples');
    expect(filled).not.toContain('阿里云');
    const material = renderToStaticMarkup(MaterialCapturePage({ namespace: 'ns', count: 0, uploadId: '11111111-1111-4111-8111-111111111111' }));
    expect(material).toContain('data-material-capture');
    expect(material).toContain('data-testid="capture-examples"');
    expect(material).toContain('平放、拍全、光线均匀');
    expect(material).toContain(CAPTURE_EXAMPLE_PAGE.path);
    expect(material).not.toContain('阿里云');
    expect(material).not.toContain('上传前看一下');
    expect(material).not.toContain('整页拍全，别裁边');
    expect(material).not.toContain('/s/consent');
    const continued = renderToStaticMarkup(MaterialCapturePage({ namespace: 'ns', count: 2, uploadId: '11111111-1111-4111-8111-111111111111' }));
    expect(continued).not.toContain('capture-examples');
    expect(continued).toContain('已拍 2 张');
  });
});
