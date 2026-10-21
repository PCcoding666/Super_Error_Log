/**
 * Synthetic capture examples for the student upload page.
 * Renders a made-up math worksheet — no student photos, names, or handwriting.
 * Run: npx tsx scripts/generate-capture-examples.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../src/web/examples');
const font = 'WenQuanYi Micro Hei, Droid Sans Fallback, sans-serif';

function paper(inner: string, width: number, height: number, pad: number): string {
  const sheetX = pad;
  const sheetY = pad;
  const sheetW = width - pad * 2;
  const sheetH = height - pad * 2;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#e4efe8"/>
  <rect x="${sheetX + 3}" y="${sheetY + 4}" width="${sheetW}" height="${sheetH}" fill="#d5ddd6"/>
  <rect x="${sheetX}" y="${sheetY}" width="${sheetW}" height="${sheetH}" fill="#fffef8"/>
  <g font-family="${font}" fill="#1c2430">${inner}</g>
</svg>`;
}

const pageSvg = paper(`
  <text x="64" y="78" font-size="28" font-weight="700">初三数学小测</text>
  <text x="64" y="112" font-size="16" fill="#5c6770">一元一次方程 · 合成示例</text>
  <line x1="64" y1="132" x2="560" y2="132" stroke="#e4e1d8" stroke-width="1"/>

  <text x="64" y="176" font-size="22">1. 解方程：3(x − 2) = 12</text>
  <text x="96" y="214" font-size="20" fill="#1d4e89">3x − 6 = 12</text>
  <text x="96" y="248" font-size="20" fill="#1d4e89">3x = 6</text>
  <text x="96" y="282" font-size="20" fill="#1d4e89">x = 2</text>
  <path d="M500 168 l46 58 M546 168 l-46 58" stroke="#c4373a" stroke-width="5" stroke-linecap="round" fill="none"/>

  <text x="64" y="348" font-size="22">2. 计算：1/2 + 1/3</text>
  <text x="96" y="386" font-size="20" fill="#1d4e89">= 5/6</text>
  <path d="M520 332 c18 22 36 48 28 52 c-22 -6 -48 -40 -58 -28" stroke="#1f7a45" stroke-width="5" stroke-linecap="round" fill="none"/>

  <text x="64" y="452" font-size="22">3. △ABC 中，∠A = 50°，∠B = 65°，求 ∠C。</text>
  <path d="M150 560 L250 470 L340 560 Z" fill="none" stroke="#243040" stroke-width="2"/>
  <text x="188" y="462" font-size="16">A</text>
  <text x="128" y="582" font-size="16">B</text>
  <text x="346" y="582" font-size="16">C</text>
  <text x="360" y="530" font-size="20" fill="#1d4e89">∠C = 75°</text>
  <path d="M520 490 l40 50 M560 490 l-40 50" stroke="#c4373a" stroke-width="5" stroke-linecap="round" fill="none"/>

  <text x="64" y="680" font-size="22">4. 解方程：2(x + 1) = 10</text>
  <text x="96" y="718" font-size="20" fill="#1d4e89">x + 1 = 5</text>
  <text x="96" y="752" font-size="20" fill="#1d4e89">x = 4</text>
  <path d="M520 670 c16 20 32 44 24 48 c-20 -6 -42 -36 -50 -24" stroke="#1f7a45" stroke-width="5" stroke-linecap="round" fill="none"/>
`, 640, 860, 28);

const questionSvg = paper(`
  <text x="48" y="64" font-size="18" fill="#5c6770">初三数学小测 · 第 1 题</text>
  <text x="48" y="118" font-size="28">解方程：3(x − 2) = 12</text>
  <text x="72" y="176" font-size="26" fill="#1d4e89">3x − 6 = 12</text>
  <text x="72" y="224" font-size="26" fill="#1d4e89">3x = 6</text>
  <text x="72" y="272" font-size="26" fill="#1d4e89">x = 2</text>
  <path d="M500 96 l52 66 M552 96 l-52 66" stroke="#c4373a" stroke-width="6" stroke-linecap="round" fill="none"/>
`, 640, 420, 24);

async function jpeg(svg: string, width: number): Promise<Buffer> {
  return sharp(Buffer.from(svg)).resize({ width, withoutEnlargement: true }).jpeg({ quality: 62, mozjpeg: true, chromaSubsampling: '4:2:0' }).toBuffer();
}

await mkdir(outDir, { recursive: true });
const page = await jpeg(pageSvg, 480);
const question = await jpeg(questionSvg, 480);
await writeFile(join(outDir, 'capture-page.jpg'), page);
await writeFile(join(outDir, 'capture-question.jpg'), question);
const pageMeta = await sharp(page).metadata();
const questionMeta = await sharp(question).metadata();
console.log(`capture-page.jpg ${page.length} bytes ${pageMeta.width}x${pageMeta.height}`);
console.log(`capture-question.jpg ${question.length} bytes ${questionMeta.width}x${questionMeta.height}`);
