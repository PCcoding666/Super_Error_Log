/**
 * 合成 fixture 生成器：全部为程序生成的匿名内容，不含任何真实学生数据。
 * 输出 fixtures/assets/week1/（17 张 PNG + 1 张带 EXIF 旋转的 JPEG + 1 个双题 PDF）+ manifest.json。
 * 幂等：重复运行覆盖同名文件，内容一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import type { FixtureManifestItem } from '../ai/mockProvider.js';
import type { Subject } from '../domain/types.js';

interface Problem {
  subject: Subject;
  tag: string;
  chapter: string;
  questionType: string;
  text: string;
  hasTeacherNote: boolean;
  hasAnswer: boolean;
  confidence: number;
}

const P = (
  subject: Subject, tag: string, questionType: string, text: string,
  opts: Partial<Pick<Problem, 'hasTeacherNote' | 'hasAnswer' | 'confidence'>> = {},
): Problem => ({
  subject, tag, chapter: `${tag} 单元`, questionType, text,
  hasTeacherNote: opts.hasTeacherNote ?? true,
  hasAnswer: opts.hasAnswer ?? true,
  confidence: opts.confidence ?? 0.93,
});

const PROBLEMS: Problem[] = [
  P('数学', '一元二次方程', '计算题', '解方程：x² − 5x + 6 = 0，并写出判别式的值。'),
  P('数学', '一元二次方程', '计算题', '用配方法解方程：2x² + 4x − 1 = 0。'),
  P('数学', '一元二次方程', '填空题', '若方程 x² + kx + 9 = 0 有两个相等实根，求 k 的值。'),
  P('数学', '二次函数', '计算题', '已知抛物线 y = x² − 2x − 3，求顶点坐标与对称轴。'),
  P('数学', '二次函数', '计算题', '二次函数 y = −x² + 4x + c 的图象过点 (1, 6)，求 c 并求最大值。', { confidence: 0.55 }),
  P('数学', '相似三角形', '证明题', '在△ABC 中，D、E 分别在 AB、AC 上且 DE∥BC，证明 △ADE∽△ABC。'),
  P('数学', '相似三角形', '计算题', '两个相似三角形面积比为 4:9，求对应边的比。'),
  P('数学', '圆的性质', '填空题', '半径为 5 的圆中，圆心到弦的距离为 3，求弦长。'),
  P('物理', '欧姆定律', '计算题', '电阻 R=10Ω 两端电压为 5V，求电流；若电压加倍，电流如何变化？'),
  P('物理', '欧姆定律', '计算题', 'R1=4Ω 与 R2=6Ω 串联接在 12V 电源上，求 R2 两端电压。'),
  P('物理', '浮力', '计算题', '体积 200cm³ 的木块漂浮在水面，浸入体积为 120cm³，求木块密度。', { confidence: 0.55 }),
  P('物理', '浮力', '填空题', '同一物体浸没在水和酒精中，哪种液体中浮力更大？说明理由。'),
  P('物理', '光的折射', '填空题', '光从空气斜射入水中，折射角与入射角的大小关系是什么？'),
  P('物理', '功与功率', '计算题', '用 50N 的力水平推箱子前进 4m，求做功；若用时 8s，求功率。'),
  P('化学', '化学方程式配平', '填空题', '配平：__Fe + __O₂ → __Fe₃O₄，并注明反应条件。'),
  P('化学', '化学方程式配平', '填空题', '配平：__C₂H₆ + __O₂ → __CO₂ + __H₂O。'),
  P('化学', '酸碱盐', '计算题', '将 20g 10% 的盐酸与足量锌反应，求生成的氢气质量（HCl 完全反应）。'),
  P('化学', '酸碱盐', '填空题', '用 pH 试纸测得某溶液 pH=3，该溶液呈什么性？滴入紫色石蕊试液变什么色？'),
  P('化学', '质量守恒', '填空题', '蜡烛燃烧后质量「变小」是否违反质量守恒定律？解释。'),
  P('化学', '金属活动性', '填空题', '把铁钉放入硫酸铜溶液中，观察到什么现象？写出化学方程式。', { hasAnswer: false }),
];

export const WEEK1_DIR = path.resolve('fixtures/assets/week1');
export const MANIFEST_PATH = path.resolve('fixtures/assets/manifest.json');

function problemHtml(p: Problem, index: number): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    body { font-family: "Songti SC", serif; background: #fff; margin: 0; }
    .sheet { width: 720px; padding: 40px; }
    .head { border-bottom: 2px solid #333; padding-bottom: 8px; margin-bottom: 16px; font-size: 14px; color: #333; }
    .q { font-size: 20px; line-height: 1.9; }
    .work { margin-top: 24px; border-top: 1px dashed #999; padding-top: 12px; color: #555; font-size: 16px; }
    .note { margin-top: 18px; color: #b91c1c; font-size: 16px; }
  </style></head><body><div class="sheet">
    <div class="head">第 ${index + 1} 题 · ${p.subject} · ${p.chapter}（合成测试材料，非真实学生作业）</div>
    <div class="q">${p.text}</div>
    <div class="work">（学生原始作答区域：此处为合成占位笔迹）</div>
    ${p.hasTeacherNote ? '<div class="note">教师批注：注意符号与单位。</div>' : ''}
  </div></body></html>`;
}

export async function generateFixtures(): Promise<{ files: number; items: number }> {
  fs.mkdirSync(WEEK1_DIR, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 1000 } });

  const manifest: FixtureManifestItem[] = [];
  const toItem = (p: Problem, itemIndex = 0) => ({
    textExcerpt: p.text,
    subject: p.subject,
    chapter: p.chapter,
    knowledgeTags: [p.tag],
    questionType: p.questionType,
    hasTeacherNote: p.hasTeacherNote,
    hasAnswer: p.hasAnswer,
    confidence: p.confidence,
    itemIndex,
  });

  // 17 张 PNG（题目 1–17）
  for (let i = 0; i < 17; i++) {
    const p = PROBLEMS[i]!;
    const filename = `W1-${String(i + 1).padStart(2, '0')}.png`;
    await page.setContent(problemHtml(p, i));
    const el = page.locator('.sheet');
    await el.screenshot({ path: path.join(WEEK1_DIR, filename), type: 'png' });
    manifest.push({ filename, items: [toItem(p)] });
  }

  // 1 张带 EXIF 旋转的 JPEG（题目 18）：先截图 PNG，再用 sharp 写入 orientation=6
  {
    const p = PROBLEMS[17]!;
    const filename = 'W1-18.jpg';
    await page.setContent(problemHtml(p, 17));
    const pngBuf = await page.locator('.sheet').screenshot({ type: 'png' });
    await sharp(pngBuf).jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toFile(path.join(WEEK1_DIR, filename));
    manifest.push({ filename, items: [toItem(p)] });
  }

  // 1 个双页 PDF（题目 19–20）
  {
    const p19 = PROBLEMS[18]!;
    const p20 = PROBLEMS[19]!;
    const filename = 'W1-19.pdf';
    await page.setContent(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
      body { font-family: "Songti SC", serif; }
      .pg { page-break-after: always; padding: 30px; }
      .q { font-size: 18px; line-height: 1.9; }
      .head { color: #555; font-size: 13px; margin-bottom: 10px; }
    </style></head><body>
      <div class="pg"><div class="head">第 19 题（合成）</div><div class="q">${p19.text}</div></div>
      <div class="pg"><div class="head">第 20 题（合成）</div><div class="q">${p20.text}</div></div>
    </body></html>`);
    await page.pdf({ path: path.join(WEEK1_DIR, filename), format: 'A4' });
    manifest.push({ filename, items: [toItem(p19, 0), { ...toItem(p20, 1), confidence: 0.55 }] });
  }

  await browser.close();
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  return { files: manifest.length, items: manifest.reduce((n, m) => n + m.items.length, 0) };
}

if (process.argv[1] && process.argv[1].endsWith('generate.ts')) {
  const r = await generateFixtures();
  console.log(`fixture 生成完成：${r.files} 个文件 / ${r.items} 道题 → fixtures/assets/week1/`);
}
