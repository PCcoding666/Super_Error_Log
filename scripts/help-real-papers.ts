/**
 * Real exam text for the public help screenshots.
 *
 * Source pages (historical, already anonymized by the export):
 * - mas_f20aa577a14a57b1 (2026-11-07) photographed exam, questions 5–9
 * - mas_7f6f02d235398a4b (2026-11-02) factorization worksheet, cropped to the question column
 *
 * Stems, circled choices, the printed factorization key, and chapter tags are transcribed
 * from those pages. No synthetic stems. Questions whose correct choice cannot be read
 * off the page (the table in 8, the figure in 9) are filed with the visible stem only
 * and are not given a scripted answer.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export const HELP_REAL_DIR = process.env.SEL_HELP_REAL_DIR ?? '/tmp/help-real/help-real-examples';

export interface HelpBox { x: number; y: number; width: number; height: number }

export interface HelpAnswer {
  /** Substring of the stem. The capture worker returns this answer only when the stem contains it. */
  includes: string;
  answer: string;
  solution: string;
  mistake?: string | null;
}

export interface HelpQuestion {
  match: string;
  number: string;
  text: string;
  work?: string;
  reference?: string;
  tags: string[];
  box: HelpBox;
  answer?: HelpAnswer;
}

export interface HelpPageSpec {
  /** Uploaded JPEG width at or above this is the exam; narrower is the worksheet. */
  minWidth: number;
  title: string | null;
  questions: HelpQuestion[];
}

const band = (y: number, height: number): HelpBox => ({ x: 0.06, y, width: 0.88, height });

export const examPage: HelpPageSpec = {
  minWidth: 3500,
  title: null,
  questions: [
    {
      match: '用配方法解方程',
      number: '5',
      text: '5. 用配方法解方程 x² − 6x − 5 = 0，配方后所得的方程是（ ）\nA. (x + 3)² = 14　B. (x − 3)² = 14　C. (x + 3)² = 4　D. (x − 3)² = 4',
      work: '圈了 B',
      tags: ['配方法', '一元二次方程'],
      box: band(0.08, 0.11),
      answer: {
        includes: '用配方法解方程',
        answer: 'B。(x − 3)² = 14',
        solution: '移项得 x² − 6x = 5。两边同加 9：x² − 6x + 9 = 14，即 (x − 3)² = 14。选 B。',
        mistake: '圈选的是 B，与配方结果一致。',
      },
    },
    {
      match: '关于原点对称',
      number: '6',
      text: '6. 若点 P(x, −√6) 与点 Q(−2√6, y) 关于原点对称，则 x + y 等于（ ）\nA. √6　B. −2√6　C. −3√6　D. 3√6',
      work: '填了 D',
      tags: ['平面直角坐标系', '关于原点对称'],
      box: band(0.19, 0.10),
      answer: {
        includes: '关于原点对称',
        answer: 'D。3√6',
        solution: '关于原点对称时 Q = −P，所以 x = 2√6，y = √6，x + y = 3√6。选 D。',
      },
    },
    {
      match: '单循环比赛',
      number: '7',
      text: '7. 某次冰壶比赛有 x 支队伍参加了单循环比赛。单循环比赛共进行了 45 场，则下列方程中符合题意的是（ ）\nA. x(x − 1) = 45　B. x(x − 1) = 90　C. x(x + 1) = 45　D. x(x + 1) = 90',
      work: '圈了 B',
      tags: ['一元二次方程', '单循环'],
      box: band(0.30, 0.11),
      answer: {
        includes: '单循环比赛',
        answer: 'B。x(x − 1) = 90',
        solution: '单循环场次是 x(x − 1)/2。等于 45 时，x(x − 1) = 90。选 B。',
      },
    },
    {
      match: '如图表格二次函数',
      number: '8',
      text: '8. 如图表格二次函数 y = ax² + bx + c 的自变量 x 与函数值 y 的对应值，判断方程 ax² + bx + c = 0（a ≠ 0，a、b、c 为常数）的一个解 x 是（ ）\nA. 6.164　B. 6.174　C. 6.184　D. 6.194',
      work: '括号处有红笔',
      tags: ['二次函数'],
      box: band(0.42, 0.12),
    },
    {
      match: '与双曲线交于',
      number: '9',
      text: '9. 如图，直线 l 经过原点，且与双曲线交于 A、C 两点。将直线 l 绕点 O 顺时针旋转 α 度角（0° < α ≤ 45°）后，与双曲线交于 B、D 两点，则四边形 ABCD 的形状是（ ）\nA. 正方形　B. 矩形　C. 菱形　D. 平行四边形',
      work: '填了 B',
      tags: ['反比例函数', '双曲线'],
      box: { x: 0.06, y: 0.515, width: 0.88, height: 0.13 },
    },
  ],
};

export const factorPage: HelpPageSpec = {
  minWidth: 0,
  title: '因式分解同步练习（解答题）',
  questions: [
    {
      match: '分解因式',
      number: '3',
      text: '3. 把下列各式分解因式：\n① a² + 10a + 25　② m² − 12mn + 36n²\n③ xy³ − 2x²y² + x³y　④ (x² + 4y²)² − 16x²y²',
      reference: '4. ① (a + 5)²　② (m − 6n)²　③ xy(x − y)²　④ (x + 2y)²(x − 2y)²',
      tags: ['因式分解', '完全平方式'],
      box: band(0.16, 0.22),
      answer: {
        includes: '分解因式',
        answer: '① (a + 5)²　② (m − 6n)²　③ xy(x − y)²　④ (x + 2y)²(x − 2y)²',
        solution: '① a² + 10a + 25 = (a + 5)²。② m² − 12mn + 36n² = (m − 6n)²。③ xy³ − 2x²y² + x³y = xy(y − x)² = xy(x − y)²。④ (x² + 4y²)² − 16x²y² = (x² + 4y²)² − (4xy)² = (x − 2y)²(x + 2y)²。',
      },
    },
    {
      match: '4x² + 12xy + 9y²',
      number: '10',
      text: '10. 已知 x = −19，y = 12，求代数式 4x² + 12xy + 9y² 的值。',
      tags: ['因式分解', '完全平方式'],
      box: band(0.56, 0.10),
      answer: {
        includes: '4x² + 12xy + 9y²',
        answer: '4',
        solution: '4x² + 12xy + 9y² = (2x + 3y)²。代入 x = −19，y = 12：2×(−19) + 3×12 = −38 + 36 = −2，(−2)² = 4。',
      },
    },
    {
      match: '互为相反数',
      number: '11',
      text: '11. 已知 |x − y + 1| 与 x² + 8x + 16 互为相反数，求 x² + 2xy + y² 的值。',
      tags: ['因式分解', '完全平方式'],
      box: band(0.68, 0.12),
      answer: {
        includes: '互为相反数',
        answer: '49',
        solution: '|x − y + 1| 与 x² + 8x + 16 = (x + 4)² 都不是负数，又互为相反数，所以都等于 0。由 (x + 4)² = 0 得 x = −4。再由 |−4 − y + 1| = 0 得 y = −3。x² + 2xy + y² = (x + y)² = (−7)² = 49。',
      },
    },
  ],
};

export const helpPages: HelpPageSpec[] = [examPage, factorPage];

export function helpAnswers(): HelpAnswer[] {
  return helpPages.flatMap(page => page.questions.flatMap(question => question.answer ? [question.answer] : []));
}

export function writeHelpAnswers(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(helpAnswers(), null, 2));
}

/** Orient the photographed exam and crop the worksheet off the webpage chrome (ads, face, phone field). */
export async function prepareHelpPages(outDir: string): Promise<{ exam: string; factor: string }> {
  fs.mkdirSync(outDir, { recursive: true });
  const exam = path.join(outDir, 'exam.jpg');
  const factor = path.join(outDir, 'factor.jpg');
  const examSource = path.join(HELP_REAL_DIR, 'mas_f20aa577a14a57b1.normalized.jpg');
  const factorSource = path.join(HELP_REAL_DIR, 'mas_7f6f02d235398a4b.normalized.jpg');
  await sharp(examSource).rotate(-90).jpeg({ quality: 85 }).toFile(exam);
  const meta = await sharp(factorSource).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width < 1000 || height < 1000) throw new Error(`factorization page is unexpected size ${width}x${height}`);
  await sharp(factorSource).extract({
    left: Math.round(width * 0.02),
    top: Math.round(height * 0.12),
    width: Math.round(width * 0.68),
    height: Math.round(height * 0.70),
  }).jpeg({ quality: 85 }).toFile(factor);
  const examMeta = await sharp(exam).metadata();
  const factorMeta = await sharp(factor).metadata();
  if ((examMeta.width ?? 0) < examPage.minWidth) throw new Error(`exam page is not wide enough after rotation: ${examMeta.width}`);
  if ((factorMeta.width ?? 0) >= examPage.minWidth) throw new Error(`worksheet crop is as wide as the exam: ${factorMeta.width}`);
  return { exam, factor };
}
