import { describe, expect, it } from 'vitest';
import {
  confirmationDateFor,
  daysBetween,
  isoWeekKey,
  plannedDateForPacket,
  selectWeeklyPlan,
} from '../../src/domain/scheduling.js';

function c(id: string, score: number, tag: string | null, conflict = false) {
  return { itemId: id, score, primaryTag: tag, conflict };
}

describe('selectWeeklyPlan', () => {
  it('按评分取 Top 5–8', () => {
    const items = Array.from({ length: 20 }, (_, i) => c(`I${i}`, 100 - i, `T${i}`));
    const r = selectWeeklyPlan(items);
    expect(r.selected).toHaveLength(8);
    expect(r.selected).toContain('I0');
    expect(r.selected).not.toContain('I19');
  });

  it('同知识点最多 2 道', () => {
    const items = [
      c('A1', 100, '方程'), c('A2', 99, '方程'), c('A3', 98, '方程'),
      c('B1', 97, '函数'), c('B2', 96, '函数'), c('C1', 95, '几何'),
      c('C2', 94, '几何'), c('D1', 93, '概率'), c('D2', 92, '概率'),
    ];
    const r = selectWeeklyPlan(items);
    expect(r.selected).toHaveLength(8);
    expect(r.selected).toContain('A1');
    expect(r.selected).toContain('A2');
    expect(r.selected).not.toContain('A3');
  });

  it('候选不足 5 道全部纳入并提示', () => {
    const r = selectWeeklyPlan([c('A', 10, 'x'), c('B', 9, 'y')]);
    expect(r.selected).toHaveLength(2);
    expect(r.notes.join('')).toContain('不足 5 道');
  });

  it('同知识点限制导致不足时从溢出补齐', () => {
    const items = [
      c('A1', 100, '方程'), c('A2', 99, '方程'), c('A3', 98, '方程'),
      c('A4', 97, '方程'), c('A5', 96, '方程'), c('A6', 95, '方程'),
    ];
    const r = selectWeeklyPlan(items);
    expect(r.selected.length).toBe(5);
    expect(r.selected).toContain('A3');
  });

  it('冲突题在备注中提示', () => {
    const items = Array.from({ length: 8 }, (_, i) => c(`I${i}`, 50 - i, `T${i}`, i === 7));
    const r = selectWeeklyPlan(items);
    expect(r.notes.join('')).toContain('冲突');
  });
});

describe('scheduling dates', () => {
  it('首包计划日期在 3–7 天窗口内', () => {
    const now = new Date('2026-09-05T10:00:00+08:00');
    const planned = plannedDateForPacket(now);
    const days = daysBetween(now, new Date(`${planned}T00:00:00+08:00`));
    expect(days).toBeGreaterThanOrEqual(3);
    expect(days).toBeLessThanOrEqual(7);
  });

  it('确认日期在 7–14 天窗口内', () => {
    const now = new Date('2026-09-05T10:00:00+08:00');
    const d = confirmationDateFor(now);
    const days = daysBetween(now, new Date(`${d}T00:00:00+08:00`));
    expect(days).toBeGreaterThanOrEqual(7);
    expect(days).toBeLessThanOrEqual(14);
  });

  it('isoWeekKey 稳定', () => {
    expect(isoWeekKey(new Date('2026-09-05T10:00:00+08:00'))).toBe('2026-W36');
  });
});
