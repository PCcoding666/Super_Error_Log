import { describe, expect, it } from 'vitest';
import {
  JPEG_QUALITY_LADDER,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_EDGE,
  PHOTO_UPLOAD_SCRIPT,
  PREPARE_TIMEOUT_MS,
  targetSize,
  UPLOAD_TIMEOUT_MS,
} from '../../src/web/photoUpload.js';

describe('targetSize（浏览器内转换的目标尺寸）', () => {
  it('48MP 照片缩到最长边 4096，比例不变', () => {
    // iPhone 48MP：8064×6048，服务端 40MP 上限会直接拒收，必须先在浏览器里缩小
    expect(targetSize(8064, 6048)).toEqual({ width: 4096, height: 3072 });
  });

  it('小图不放大', () => {
    expect(targetSize(1000, 800)).toEqual({ width: 1000, height: 800 });
    expect(targetSize(800, 1000)).toEqual({ width: 800, height: 1000 });
  });

  it('正好等于上限不变；竖图按长边缩', () => {
    expect(targetSize(4096, 4096)).toEqual({ width: 4096, height: 4096 });
    expect(targetSize(3024, 4032)).toEqual({ width: 3024, height: 4032 });
    expect(targetSize(6048, 8064)).toEqual({ width: 3072, height: 4096 });
  });

  it('非法尺寸抛错（脚本侧按读不出来处理）', () => {
    expect(() => targetSize(0, 100)).toThrow();
    expect(() => targetSize(100, -1)).toThrow();
  });
});

describe('上传常量', () => {
  it('质量阶梯先高质量再逐级降，首张 0.92', () => {
    expect(JPEG_QUALITY_LADDER[0]).toBeCloseTo(0.92);
    expect(JPEG_QUALITY_LADDER.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < JPEG_QUALITY_LADDER.length; i += 1) {
      expect(JPEG_QUALITY_LADDER[i]!).toBeLessThan(JPEG_QUALITY_LADDER[i - 1]!);
    }
  });

  it('字节上限与服务端一致（15MB），超时都有界', () => {
    expect(MAX_UPLOAD_BYTES).toBe(15 * 1024 * 1024);
    expect(PREPARE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(UPLOAD_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('PHOTO_UPLOAD_SCRIPT（嵌入 CLIENT_SCRIPT 的浏览器脚本）', () => {
  it('浏览器内转换：objectURL 解码 + canvas 转 JPEG，禁止只改扩展名', () => {
    expect(PHOTO_UPLOAD_SCRIPT).toContain('URL.createObjectURL');
    expect(PHOTO_UPLOAD_SCRIPT).toContain('canvas.toBlob');
    expect(PHOTO_UPLOAD_SCRIPT).toContain("'image/jpeg'");
    expect(PHOTO_UPLOAD_SCRIPT).toContain('drawImage');
  });

  it('状态文案：准备 → 上传 → 传完等处理', () => {
    expect(PHOTO_UPLOAD_SCRIPT).toContain('正在准备照片…');
    expect(PHOTO_UPLOAD_SCRIPT).toContain('正在上传 ');
    expect(PHOTO_UPLOAD_SCRIPT).toContain('上传完成，正在处理照片…');
  });

  it('2xx 但不是 {ok:true, jobId} 不算成功', () => {
    expect(PHOTO_UPLOAD_SCRIPT).toContain("body.ok===true&&typeof body.jobId==='string'");
  });

  it('幂等 key 同一张重试保持稳定；有超时与单并发', () => {
    expect(PHOTO_UPLOAD_SCRIPT).toContain("data.append('key',entry.key)");
    expect(PHOTO_UPLOAD_SCRIPT).toContain('xhr.timeout=UPLOAD_MS');
    expect(PHOTO_UPLOAD_SCRIPT).toContain('if(!f||busy)return');
  });

  it('HEIC 读不了时提示换 Safari 或 JPEG，不给假成功', () => {
    expect(PHOTO_UPLOAD_SCRIPT).toContain('HEIC');
    expect(PHOTO_UPLOAD_SCRIPT).toContain('Safari');
    expect(PHOTO_UPLOAD_SCRIPT).toContain('prepare_heic');
  });
});
