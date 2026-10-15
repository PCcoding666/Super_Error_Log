import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlanPage } from '../../src/views/plan.js';
import { selectWeeklyPlan } from '../../src/domain/scheduling.js';

describe('计划界面使用真实选题规则', () => {
  it('知识点单一时不是无条件勾选前八题，并解释放宽上限', () => {
    const recommendations = Array.from({ length: 10 }, (_, i) => ({ itemId: `I${i}`, shortId: `M${i}`, subject: '数学', primaryTag: '方程', score: 100-i, reasons: [], conflict: false }));
    const html = renderToStaticMarkup(PlanPage({ role: 'student', recommendations, notes: [] }));
    expect((html.match(/checked=""/g) ?? []).length).toBe(selectWeeklyPlan(recommendations).selected.length);
    expect(html).toContain('放宽');
  });
});
