/**
 * T5-R2 F1：打印专用裁图余量、遮白矩形像素坐标、题号规整（纯函数 + sharp 合成图）。
 * 不调用真实模型、不读 .env 与 data/。
 */
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { Evidence } from '../../src/ai/evidence.js';
import {
  expandPrintCropMargin,
  maskedQuestionCrop,
  normalizeQuestionNumber,
  printMaskRects,
} from '../../src/v2/printService.js';

function evidenceWithRegions(regions: Evidence['regions']): Evidence {
  return {
    version: 1, questionNumber: '4', questionText: '题干', subject: '数学', chapter: '',
    knowledgeTags: [], questionType: '计算',
    questionRegion: { x: 0, y: 0, width: 1, height: 1 }, requiresDiagram: false,
    regions, observations: [], uncertainties: [],
  };
}

describe('T5R2-F1 打印专用裁图余量 expandPrintCropMargin', () => {
  it('真实数据：{x:0,y:0.8105,w:1,h:0.074} 的结果区域必须包含 y=0.795', () => {
    const crop = expandPrintCropMargin({ x: 0, y: 0.8105, width: 1, height: 0.074 });
    // dy = clamp(0.074*0.5, 0.02, 0.04) = 0.037 → 上沿 0.7735，盖住题干真实上沿 0.800。
    expect(crop.y).toBeLessThanOrEqual(0.795);
    expect(crop.y).toBeCloseTo(0.8105 - 0.037, 6);
    expect(crop.y + crop.height).toBeGreaterThan(0.8105 + 0.074);
  });

  it('纵向余量上下限：矮框夹到 0.02，高框夹到 0.04；横向沿用识别规则', () => {
    const small = expandPrintCropMargin({ x: 0.5, y: 0.5, width: 0.1, height: 0.01 });
    expect(small.y).toBeCloseTo(0.48, 6); // dy = max(0.01*0.5, 0.02) = 0.02
    expect(small.x).toBeCloseTo(0.49, 6); // dx = clamp(0.1*0.06, 0.01, 0.03) = 0.01
    const tall = expandPrintCropMargin({ x: 0.5, y: 0.5, width: 0.1, height: 0.2 });
    expect(tall.y).toBeCloseTo(0.46, 6); // dy = min(0.2*0.5, 0.04) = 0.04
  });

  it('裁到页面边界内', () => {
    const crop = expandPrintCropMargin({ x: 0, y: 0.95, width: 1, height: 0.05 });
    expect(crop.x).toBe(0);
    expect(crop.y + crop.height).toBeLessThanOrEqual(1);
    expect(crop.y + crop.height).toBe(1); // 下沿顶到页底
  });
});

describe('T5R2-F1 遮白矩形 printMaskRects（整页像素坐标，贴边遮到边）', () => {
  const width = 1000;
  const height = 2000;
  const crop = { x: 0.1, y: 0.2, width: 0.5, height: 0.3 };
  const left = Math.floor(crop.x * width);
  const top = Math.floor(crop.y * height);
  const right = Math.min(width, Math.ceil((crop.x + crop.width) * width));
  const bottom = Math.min(height, Math.ceil((crop.y + crop.height) * height));

  it('订正区域跨过裁图底边/右边时，遮白一直遮到那条边，不留像素缝', () => {
    const e = evidenceWithRegions([
      { id: 'c1', kind: 'correction', box: { x: 0.5, y: 0.45, width: 0.2, height: 0.1 }, confidence: 0.9, cleanForPrint: false },
    ]);
    const rects = printMaskRects(e, crop, width, height);
    expect(rects).toHaveLength(1);
    expect(rects[0]!.x + rects[0]!.width).toBe(right - left); // 贴住裁图右边
    expect(rects[0]!.y + rects[0]!.height).toBe(bottom - top); // 贴住裁图底边
  });

  it('纵向外扩 1.2%：底边距裁图上沿 1.5% 的区域不进裁图，1.0% 的进', () => {
    const near = (bottomEdge: number) => evidenceWithRegions([
      { id: 'c1', kind: 'correction', box: { x: 0.2, y: bottomEdge - 0.01, width: 0.2, height: 0.01 }, confidence: 0.9, cleanForPrint: false },
    ]);
    expect(printMaskRects(near(0.185), crop, width, height)).toHaveLength(0); // 0.185+0.012=0.197 < 0.2
    expect(printMaskRects(near(0.19), crop, width, height)).toHaveLength(1); // 0.19+0.012=0.202 > 0.2
  });

  it('diagram 区域不遮白；完全在裁图外的区域不产生矩形', () => {
    const e = evidenceWithRegions([
      { id: 'd1', kind: 'diagram', box: { x: 0.2, y: 0.3, width: 0.1, height: 0.1 }, confidence: 0.9, cleanForPrint: false },
      { id: 'c1', kind: 'correction', box: { x: 0.05, y: 0.9, width: 0.02, height: 0.05 }, confidence: 0.9, cleanForPrint: false },
    ]);
    expect(printMaskRects(e, crop, width, height)).toHaveLength(0);
  });

  it('合成图走查：订正区域跨过裁图底边时，裁图最后一行在遮白横向范围内纯白', async () => {
    // 400×400 白底，黑色"订正块" 页 x 40..120、y 250..290（即 0.1..0.3 / 0.625..0.725）。
    const black = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#000000' } }).png().toBuffer();
    const source = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#ffffff' } })
      .composite([{ input: black, left: 40, top: 250 }]).jpeg().toBuffer();
    const e: Evidence = {
      ...evidenceWithRegions([
        { id: 'c1', kind: 'correction', box: { x: 0.1, y: 0.625, width: 0.2, height: 0.1 }, confidence: 0.9, cleanForPrint: false },
      ]),
      questionRegion: { x: 0, y: 0, width: 1, height: 0.6 },
    };
    const out = await maskedQuestionCrop(source, e);
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    // 打印余量 dy = clamp(0.6*0.5, 0.02, 0.04) = 0.04 → 裁图底边在页 64%（≥256 行）；
    // 旧识别余量只有 1.2%（245 行），订正块下沿 290 根本进不了裁图。
    expect(info.height).toBeGreaterThanOrEqual(256);
    const pixel = (x: number, y: number): number => data[(y * info.width + x) * info.channels]!;
    // 遮白横向范围：0.1±0.01 → 页像素 x 36..125（floor 起点、ceil 终点）。
    for (let x = 36; x <= 124; x += 1) {
      expect(pixel(x, info.height - 1), `最后一行 x=${x}`).toBeGreaterThan(200);
    }
  });
});

describe('T5R2-F2 fallbackNote 题号规整 normalizeQuestionNumber', () => {
  it('去掉首尾空白、结尾标点、开头括号和"第"、结尾"题"', () => {
    expect(normalizeQuestionNumber('2.')).toBe('2');
    expect(normalizeQuestionNumber('（3）')).toBe('3');
    expect(normalizeQuestionNumber('第4题')).toBe('4');
    expect(normalizeQuestionNumber('13')).toBe('13');
    expect(normalizeQuestionNumber(' 5、')).toBe('5');
    expect(normalizeQuestionNumber('7：')).toBe('7');
    expect(normalizeQuestionNumber('(8)')).toBe('8');
    expect(normalizeQuestionNumber('9．')).toBe('9');
  });

  it('规整后为空则用原值', () => {
    expect(normalizeQuestionNumber('.')).toBe('.');
    expect(normalizeQuestionNumber('题')).toBe('题');
  });
});
