/**
 * T4f：整题大图区域 fullItemRegion（纯函数）。
 * 题目区域与全部证据区域的并集，再用打印同款余量外扩，裁到页面边界内。
 * 不调用真实模型、不读 .env 与 data/。
 */
import { describe, expect, it } from 'vitest';
import type { Evidence } from '../../src/ai/evidence.js';
import { expandPrintCropMargin } from '../../src/v2/printService.js';
import { fullItemRegion } from '../../src/v2/fullCrop.js';

function evidenceWith(questionRegion: Evidence['questionRegion'], regions: Evidence['regions']): Evidence {
  return {
    version: 1, questionNumber: '1', questionText: '题干', subject: '数学', chapter: '',
    knowledgeTags: [], questionType: '计算',
    questionRegion, requiresDiagram: false,
    regions, observations: [], uncertainties: [],
  };
}

const region = (id: string, box: Evidence['regions'][number]['box']): Evidence['regions'][number] =>
  ({ id, kind: 'student_work', box, confidence: 0.9, cleanForPrint: false });

describe('T4f fullItemRegion 整题大图区域', () => {
  it('真实数据：题目区域 + 作答 + 订正的并集外扩后必须包含 y=0.795 与 y=0.905，且不超出 [0,1]', () => {
    const evidence = evidenceWith(
      { x: 0, y: 0.8105, width: 1, height: 0.074 },
      [
        region('s1', { x: 0.08, y: 0.835, width: 0.22, height: 0.03 }),
        region('c1', { x: 0.08, y: 0.875, width: 0.43, height: 0.03 }),
      ],
    );
    const box = fullItemRegion(evidence);
    expect(box.y).toBeLessThanOrEqual(0.795);
    expect(box.y + box.height).toBeGreaterThanOrEqual(0.905);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1);
    expect(box.y + box.height).toBeLessThanOrEqual(1);
  });

  it('题干很窄而作答在其下方很宽：并集覆盖两者', () => {
    const evidence = evidenceWith(
      { x: 0.4, y: 0.2, width: 0.2, height: 0.05 },
      [region('s1', { x: 0.05, y: 0.3, width: 0.9, height: 0.1 })],
    );
    const box = fullItemRegion(evidence);
    // 并集 x 0.4..0.6 与 0.05..0.95 → 0.05..0.95，再外扩横向 dx=clamp(0.9*0.06,0.01,0.03)=0.03
    expect(box.x).toBeLessThanOrEqual(0.4);
    expect(box.x + box.width).toBeGreaterThanOrEqual(0.6);
    expect(box.x).toBeLessThanOrEqual(0.05);
    expect(box.x + box.width).toBeGreaterThanOrEqual(0.95);
    expect(box.y).toBeLessThanOrEqual(0.2);
    expect(box.y + box.height).toBeGreaterThanOrEqual(0.4);
  });

  it('没有任何区域：等于题目区域外扩', () => {
    const questionRegion = { x: 0.2, y: 0.3, width: 0.5, height: 0.1 };
    expect(fullItemRegion(evidenceWith(questionRegion, []))).toEqual(expandPrintCropMargin(questionRegion));
  });

  it('区域贴着页面边缘：不越界', () => {
    const evidence = evidenceWith(
      { x: 0, y: 0, width: 0.5, height: 0.1 },
      [
        region('s1', { x: 0.5, y: 0.9, width: 0.5, height: 0.1 }),
        region('d1', { x: 0, y: 0.95, width: 1, height: 0.05 }),
      ],
    );
    const box = fullItemRegion(evidence);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1);
    expect(box.y + box.height).toBeLessThanOrEqual(1);
    // 并集已贴满全页，外扩后就是整页
    expect(box.x).toBe(0);
    expect(box.y).toBe(0);
    expect(box.width).toBe(1);
    expect(box.height).toBe(1);
  });
});
