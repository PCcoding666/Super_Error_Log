/** Synthetic work with deliberately incorrect calculations: formatting must not solve it. */
export const LONG_ANSWER = `(1) { 0 = 9a - 3b + 4; 0 = 16a + 4b + 4 } 解得 a = -1/3; b = 1/3
因此 y = -1/3 x² + 1/3 x + 4
(2) C(0,4)，设 M(m,0)（0 < m < 4），则 Q(m,4-m)
AC = √(4²+3²) = 5
① AC = AQ 时 (m+3)² + (4-2m)² = 25，m=0 舍去，m=2
② AC = CQ 时 2m² = 25，m = 5√2/2
③ CQ = AQ 时 3m² - 10m + 25 = 0，Δ < 0，无解
Q(2,2)，Q₁(5√2/2,(8-5√2)/2)`;

export const answerItem = {
  id: 'itm_0123456789abcdef', shortId: 'Q01', grade: '初三', subject: '数学',
  chapter: '二次函数', knowledgeTags: [], questionExcerpt: '求抛物线解析式及点的坐标。',
  status: 'eligible_for_review' as const, badge: 'ok' as const, cropUrl: '', jobId: 'synthetic',
};
