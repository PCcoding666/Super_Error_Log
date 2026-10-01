// 生成 App 图标（1024×1024，浅色 / 深色 / 着色三种外观）。
// 设计：一张纸上的红叉（错题）+ 右下角的"重做"环形箭头。
// 用法（仓库根目录）：node iOS/scripts/make-app-icon.mjs
// 依赖根目录 node_modules 里的 sharp；输出到 iOS/StudentApp/Assets.xcassets/AppIcon.appiconset/。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const require = createRequire(path.join(root, 'package.json'));
const sharp = require('sharp');
const out = path.join(root, 'iOS/StudentApp/Assets.xcassets/AppIcon.appiconset');

const rad = d => d * Math.PI / 180;

/** 顺时针的环形箭头：从 a1 到 a2（SVG 坐标，y 向下），末端带箭头。 */
function loop({ cx, cy, r, w, a1 = -35, a2 = 250, color }) {
  const p = a => [cx + r * Math.cos(rad(a)), cy + r * Math.sin(rad(a))];
  const [x1, y1] = p(a1); const [x2, y2] = p(a2);
  const t = [-Math.sin(rad(a2)), Math.cos(rad(a2))];
  const n = [Math.cos(rad(a2)), Math.sin(rad(a2))];
  const L = w * 1.5, H = w * 1.2;
  const tip = [x2 + t[0] * L, y2 + t[1] * L];
  const b1 = [x2 + n[0] * H, y2 + n[1] * H]; const b2 = [x2 - n[0] * H, y2 - n[1] * H];
  return `<path d="M ${x1} ${y1} A ${r} ${r} 0 1 1 ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>
  <path d="M ${tip[0]} ${tip[1]} L ${b1[0]} ${b1[1]} L ${b2[0]} ${b2[1]} Z" fill="${color}" stroke="${color}" stroke-width="${w * 0.22}" stroke-linejoin="round"/>`;
}

function cross({ cx, cy, s, w, color }) {
  return `<g stroke="${color}" stroke-width="${w}" stroke-linecap="round"><line x1="${cx - s}" y1="${cy - s}" x2="${cx + s}" y2="${cy + s}"/><line x1="${cx + s}" y1="${cy - s}" x2="${cx - s}" y2="${cy + s}"/></g>`;
}

function icon({ top, bottom, paper, lines, mark, ring, disc, arrow }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>
  <rect width="1024" height="1024" fill="url(#bg)"/>
  <g transform="rotate(-6 512 512)">
    <rect x="222" y="160" width="540" height="696" rx="58" fill="${paper}"/>
    <g stroke="${lines}" stroke-width="18" stroke-linecap="round">
      <line x1="292" y1="622" x2="692" y2="622"/><line x1="292" y1="702" x2="692" y2="702"/><line x1="292" y1="782" x2="560" y2="782"/>
    </g>
    ${cross({ cx: 492, cy: 398, s: 112, w: 72, color: mark })}
  </g>
  <circle cx="744" cy="744" r="182" fill="${ring}"/>
  <circle cx="744" cy="744" r="154" fill="${disc}"/>
  ${loop({ cx: 744, cy: 744, r: 80, w: 32, color: arrow })}
</svg>`;
}

const variants = {
  'icon-1024.png': icon({ top: '#2B7F77', bottom: '#174E4A', paper: '#FBFAF5', lines: '#D5DAD0', mark: '#C8402F', ring: '#174E4A', disc: '#DEEBDE', arrow: '#1F615C' }),
  'icon-1024-dark.png': icon({ top: '#16302E', bottom: '#0B1716', paper: '#E4E6DF', lines: '#B4BAB0', mark: '#D9574A', ring: '#0B1716', disc: '#6BB8AD', arrow: '#0D2523' }),
  // 着色外观：系统会用用户选的颜色给灰度图上色，所以这里只给明暗关系。
  'icon-1024-tinted.png': icon({ top: '#1A1A1A', bottom: '#0A0A0A', paper: '#D9D9D9', lines: '#8C8C8C', mark: '#4D4D4D', ring: '#0A0A0A', disc: '#FFFFFF', arrow: '#333333' }),
};

fs.mkdirSync(out, { recursive: true });
for (const [name, svg] of Object.entries(variants)) {
  // 图标不带透明通道。
  await sharp(Buffer.from(svg)).flatten({ background: '#000000' }).removeAlpha().png().toFile(path.join(out, name));
}
fs.writeFileSync(path.join(out, 'Contents.json'), JSON.stringify({
  images: [
    { filename: 'icon-1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' },
    { appearances: [{ appearance: 'luminosity', value: 'dark' }], filename: 'icon-1024-dark.png', idiom: 'universal', platform: 'ios', size: '1024x1024' },
    { appearances: [{ appearance: 'luminosity', value: 'tinted' }], filename: 'icon-1024-tinted.png', idiom: 'universal', platform: 'ios', size: '1024x1024' },
  ],
  info: { author: 'xcode', version: 1 },
}, null, 2) + '\n');
console.log(`已生成 ${Object.keys(variants).length} 张图标到 ${path.relative(root, out)}`);
