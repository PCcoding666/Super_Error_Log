import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ItemDetailPage } from '../../src/web/views/items.js';

const item = { id: 'itm_0123456789abcdef', shortId: 'Q01', grade: '初三', subject: '数学', chapter: '二次函数', knowledgeTags: [], questionExcerpt: '求 x 的值', status: 'eligible_for_review' as const, badge: 'ok' as const, cropUrl: '', jobId: 'synthetic' };
const reflection = { id: 'diag_test', attemptState: '方法基本正确但步骤出错' as const, cause: '计算' as const, masteryFeeling: 2 as const, summary: '移项忘了变号', adoptedAi: false, source: 'v2', createdAt: '2026-10-19T00:00:00Z' };
const render = (extra = {}) => renderToStaticMarkup(ItemDetailPage({ item, evidence: null, canDiscard: true, reflected: false, ...extra }));

describe('single-question learning', () => {
  it.each([
    ['Asia/Shanghai','2026-10-18T16:30:00.000Z','2026-10-19'],
    ['America/Los_Angeles','2026-10-19T00:30:00.000Z','2026-10-18'],
  ])('reflection confirmation date uses %s across UTC midnight', (timeZone,createdAt,displayDay) => {
    const html = render({reflection:{...reflection,createdAt},timeZone});
    expect(html).toContain(`<time dateTime="${createdAt}">${displayDay}</time>`);
  });
  it('reads the student-confirmed reflection and confidence, instead of a boolean status', () => {
    const html = render({ reflection });
    expect(html).toContain('移项忘了变号');
    expect(html).toContain('方法基本正确但步骤出错');
    expect(html).toContain('现在重做应该会');
  });
  it('shows a neutral empty reflection without inventing a cause or requiring reflection', () => {
    const html = render();
    expect(html).toContain('还没有已确认的错因记录');
    expect(html).not.toContain('还没说为什么错');
    expect(html).toContain('重做这题');
  });
  it('makes retry primary, keeps corrections secondary, and preserves a safe notebook return', () => {
    const html = render({ eligible: true, returnTo: '/s/items?grade=初三&subject=数学&q=方程#item-itm_0123456789abcdef' });
    expect(html).toContain(`action="/s/items/${item.id}/practice"`);
    expect(html).toMatch(/data-testid="next-step-primary"[^>]*>.*重做这题/);
    expect(html).toContain('q=%E6%96%B9%E7%A8%8B');
    for (const returnTo of ['https://evil.example/s/items','//evil.example/s/items','/s/items/../settings','/s/items?next=https://evil.example','/s/items#unexpected']) {
      const rejected = render({returnTo});
      expect(rejected).not.toContain('evil.example');
      expect(rejected).toContain(`href="/s/items?grade=%E5%88%9D%E4%B8%89&amp;subject=%E6%95%B0%E5%AD%A6#item-${item.id}"`);
    }
    expect(render({ returnTo: '/s/settings' })).toContain('#item-itm_0123456789abcdef');
  });
  it('keeps canonical notebook status validation and the item anchor on detail returns', () => {
    const html = render({returnTo:'/s/items?grade=初三&subject=数学&status=toString&q=方程'});
    expect(html).not.toContain('status=toString');
    expect(html).toContain(`q=%E6%96%B9%E7%A8%8B#item-${item.id}`);
  });
  it('carries validated notebook and selection context into management links and discard',()=>{
    const returnTo=`/s/items?${new URLSearchParams({grade:'初三',subject:'数学',chapter:'方程',q:'x',mode:'select',itemIds:item.id})}#item-${item.id}`;
    const html=render({returnTo,evidence:{questionText:'题目',badge:'ok',observations:[]}});
    for(const action of ['fix','category']) expect(html).toContain(`/s/items/${item.id}/${action}?${new URLSearchParams({returnTo})}`);
    expect(html).toContain(`name="returnTo" value="${returnTo.replaceAll('&','&amp;')}"`);
  });
  it('resumes an existing unfinished practice as the primary action', () => {
    const html = render({ resumePracticeId: 'pkt_0123456789abcdef', eligible: false });
    expect(html).toMatch(/aria-label="继续练习" data-testid="next-step-primary"/);
    expect(html).toContain(`/s/practice/pkt_0123456789abcdef?item=${item.id}`);
    expect(html).not.toContain(`action="/s/items/${item.id}/practice"`);
  });
  it('labels actual completion and hint use without calling same-day or hinted results mastery', () => {
    const rows = [
      {id:'pkt_1',correct:1,completion:'independent',hint_level:0,performed_at:'2026-10-19',generated_day:'2026-10-19'},
      {id:'pkt_2',correct:1,completion:'hint_used',hint_level:2,performed_at:'2026-10-19',generated_day:'2026-10-12'},
      {id:'pkt_3',correct:1,completion:'independent',hint_level:0,performed_at:'2026-10-19',generated_day:'2026-10-12'},
      {id:'pkt_4',correct:0,completion:'unfinished',hint_level:0,performed_at:'2026-10-19'},
      {id:'pkt_5',correct:null,completion:null,performed_at:null},
    ];
    const html = render({practiceHistory:rows});
    for (const label of ['当天独立做对', '未计入延迟掌握', '用了二级提示后做对', '隔 7 天独立做对', '未完成', '尚未作答']) expect(html).toContain(label);
    expect(html).not.toContain('已掌握');
    const early = render({practiceHistory:[{id:'pkt_6',correct:1,completion:'independent',hint_level:0,performed_at:'2026-10-19',generated_day:'2026-10-17'}]});
    expect(early).toContain('隔 2 天独立做对 · 未计入延迟掌握');
    const missing = render({practiceHistory:[{id:'pkt_7',correct:1,performed_at:'2026-10-19'}]});
    expect(missing).toContain('做对了（未记录完成方式）');
  });
  it('keeps original work and reference answers inside native collapsed disclosures', () => {
    const html = render({ evidence: { questionText: '题目全文', badge: 'ok', observations: [{id:'a',kind:'student_work',text:'原来写的 x=3'},{id:'b',kind:'reference_answer',text:'正确 x=2'}] } });
    expect(html).toMatch(/<details[^>]*><summary[^>]*>你写的/);
    expect(html).toMatch(/<details[^>]*><summary[^>]*>参考答案/);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain('?scope=full&amp;s=big');
  });
});
