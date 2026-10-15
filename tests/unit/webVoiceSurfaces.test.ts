/**
 * 语音入口（data-voice-for）在网页版三个候选场景的实际覆盖核查：
 * - 反思回答（practice.tsx WhyAskPage）与题目修改指令（items.tsx FixPage）已有同一语音入口，这里断言它们的
 *   标记约定（目标输入框、/s/voice、隐私提示）不回归；
 * - 「报题号选择」在网页版没有现成的文字输入/解析入口（选题与勾题都是复选框提交 questionIds/itemIds），
 *   不临时造语音解析，见 docs/quality/2026-10-15-web-voice-acceptance.md；
 * - 浏览器行为由既有 e2e 与 asr/transcribe 测试覆盖，不以脚本文本匹配替代行为检查。
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FixPage } from '../../src/web/views/items.js';
import { WhyAskPage } from '../../src/web/views/practice.js';
import type { V2WeekItem } from '../../src/v2/weekService.js';
import type { PracticeCard } from '../../src/v2/practiceService.js';
import type { ReflectionTurnView } from '../../src/v2/reflectionService.js';

const VOICE_NOTICE = '录音会发给通义千问转文字，本应用不保存录音；最多 60 秒，也可以直接打字';

const item: V2WeekItem = {
  id: 'item-1', shortId: 'A1', subject: '数学', knowledgeTags: ['方程'],
  questionExcerpt: '解方程 …', badge: 'ok', status: 'needs_review', cropUrl: '/s/img/item/item-1', jobId: 'job-1',
};
const card: PracticeCard = { ...item, reason: '最近错过', tier: 1, reflected: false };
const openTurn: ReflectionTurnView = { turn: 1, question: '当时怎么想的？', source: 'ai', answer: null };

describe('语音入口：反思回答与修改指令复用同一组件约定', () => {
  it('反思回答页：语音入口指向回答输入框，只走 /s/voice，带隐私提示', () => {
    const html = renderToStaticMarkup(WhyAskPage({ practiceId: 'p1', card, index: 0, total: 3, turns: [openTurn] }));
    expect(html).toContain('data-voice-for="answer-text"');
    expect(html).toContain('data-endpoint="/s/voice"');
    expect(html).toContain('id="answer-text"');
    expect(html).toContain(VOICE_NOTICE);
    // 提交仍是学生点击的表单提交（转写只填进输入框）
    expect(html).toContain('action="/s/why/p1/item-1/answer"');
  });

  it('题目修改指令页：同一语音入口约定，method 默认 keyboard', () => {
    const html = renderToStaticMarkup(FixPage({ item, revision: 1, clientRequestId: 'req-1' }));
    expect(html).toContain('data-voice-for="fix-instruction"');
    expect(html).toContain('data-endpoint="/s/voice"');
    expect(html).toContain('id="fix-instruction"');
    expect(html).toContain(VOICE_NOTICE);
    expect(html).toContain('name="method" value="keyboard"');
  });
});

