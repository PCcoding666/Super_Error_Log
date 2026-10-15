/**
 * 题目裁图按显示尺寸下发（quality round 2，标准 E1：「题目裁图按显示尺寸的 2 倍以内缩放后再下发」）。
 * 只在内存里缩小，磁盘上的原图不动；原图已经比目标小时原样返回（从不放大，也不为了「缩小」重新压一遍）。
 * 显示尺寸（CSS px，内容区最宽 544）：
 * - thumb：清单里的小方图（.thumb，最大 84×64）→ 168×168 以内
 * - list：列表里的裁图（.crop，高 96、最宽 544）→ 1088×192 以内
 * - big：整宽的裁图（.crop.big，最宽 544）→ 宽 1088 以内
 */
import crypto from 'node:crypto';
import sharp from 'sharp';

export type DisplaySize = 'thumb' | 'list' | 'big';
const BOUNDS: Record<DisplaySize, { width: number; height?: number }> = {
  thumb: { width: 168, height: 168 },
  list: { width: 1088, height: 192 },
  big: { width: 1088 },
};

export function displaySize(value: unknown): DisplaySize | null {
  return value === 'thumb' || value === 'list' || value === 'big' ? value : null;
}

// 同一张图、同一个尺寸只缩一次（按内容指纹记在内存里，最多 300 张；学生数据，不落盘）。
const cache = new Map<string, Buffer>();

export async function displayImage(source: Buffer, size: DisplaySize | null): Promise<Buffer> {
  if (!size) return source;
  const bound = BOUNDS[size];
  const key = `${size}:${crypto.createHash('sha1').update(source).digest('hex')}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const meta = await sharp(source).metadata();
  const fits = (meta.width ?? 0) <= bound.width && (bound.height === undefined || (meta.height ?? 0) <= bound.height);
  const out = fits ? source : await sharp(source).resize({ width: bound.width, height: bound.height, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  const result = out.length < source.length ? out : source;
  cache.set(key, result);
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  return result;
}
