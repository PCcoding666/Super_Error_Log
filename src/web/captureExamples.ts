/**
 * 错题录入页的拍摄示例。文件是脚本生成的合成数学卷，不含学生照片。
 * 生产包只带 dist/，构建时把 jpeg 复制到 dist/web/examples（见 package.json build）。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function load(name: string): Buffer {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'examples', name));
}

function publish(fileName: string, bytes: Buffer): { bytes: Buffer; hash: string; path: string } {
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 10);
  const stem = fileName.replace(/\.jpg$/, '');
  return { bytes, hash, path: `/s/assets/${stem}.${hash}.jpg` };
}

export const CAPTURE_EXAMPLE_PAGE = publish('capture-page.jpg', load('capture-page.jpg'));
export const CAPTURE_EXAMPLE_QUESTION = publish('capture-question.jpg', load('capture-question.jpg'));
