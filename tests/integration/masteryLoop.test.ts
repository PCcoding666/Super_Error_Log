/**
 * P0-3 掌握闭环的日历模拟（合成数据，mock AI）。
 * 来源：生产就绪排查 2026-10-22 的 masteryLoop / backlog / stable 复现脚本。
 * 规则：当天做对不算掌握；延迟从「这道题上一次作答日 / 录入日」算，而不是练习包生成日；
 * 确认轮先判轮次再判天数，不降级；积压的新错题轮得到。
 * 「今天该做」：每道题到期才排（新错题录入 + 3 天，做过的上次作答 + 3 天，确认题到确认日），每天最多 5 道。
 */
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../src/db/connection.js';
import { createLearningPractice, learningRedoOverview } from '../../src/learning/queries.js';
import * as tasks from '../../src/v2/practiceTasks.js';
import { getLearningReturnSummary, submitLearningReturns } from '../../src/v2/returnService.js';
import { clearPracticeFixtures, seedPracticeItems } from '../helpers/practiceTask.js';

/** 2026-10-22 + n 天，本地 20:00（晚自习后）。 */
const day = (n: number): Date => new Date(2026, 9, 22 + n, 20, 0, 0);
const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const at = (n: number): void => { vi.setSystemTime(day(n)); };

function started(result: ReturnType<typeof tasks.startSuggestedPractice>): string {
  if (!result.ok) throw new Error(result.message);
  getDb().prepare("UPDATE review_packet SET status='generated', generated_at=? WHERE id=?").run(new Date().toISOString(), result.detail.id);
  return result.detail.id;
}
/** 接受「今天该做」（「开始做这 N 道」），并像打印/开始练习那样写下生成时间。 */
function startSuggested(): string {
  return started(tasks.startSuggestedPractice('/none', crypto.randomUUID()));
}
/** 没到日期，自己选题提前练。 */
function startEarly(ids: string[]): string {
  return started(createLearningPractice({ itemIds: ids, requestKey: crypto.randomUUID() }));
}
function packetItems(packetId: string): string[] {
  return (getDb().prepare('SELECT item_id FROM review_packet_item WHERE packet_id=? ORDER BY position').all(packetId) as { item_id: string }[]).map(row => row.item_id);
}
function doAll(packetId: string, performed: Date, correct: (index: number) => boolean = () => true) {
  const result = submitLearningReturns(packetId, {
    results: packetItems(packetId).map((itemId, index) => ({ itemId, completion: 'independent', correct: correct(index), performedOn: ymd(performed) })),
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  for (const entry of result.results) if (!entry.ok) throw new Error(JSON.stringify(entry));
  return result;
}
const status = (id: string): string => (getDb().prepare('SELECT status FROM error_item WHERE id=?').get(id) as { status: string }).status;
const statuses = (ids: string[]): string[] => ids.map(status);
const masteryEvents = (): Array<{ from_status: string; to_status: string }> =>
  getDb().prepare("SELECT from_status, to_status FROM mastery_event WHERE to_status IN ('temporarily_mastered','stably_mastered') OR from_status IN ('temporarily_mastered','stably_mastered') ORDER BY rowid").all() as Array<{ from_status: string; to_status: string }>;

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); at(0); clearPracticeFixtures(); });
afterEach(() => { vi.useRealTimers(); });

describe('P0-3 默认流程（今天该做、当天做完）能走到掌握', () => {
  it('新错题录入 3 天后才排进来，那天独立做对 → 暂时掌握；到期确认 → 稳定掌握', () => {
    const ids = seedPracticeItems(3);

    // 录入后 3 天内不排：刚收的错题当天再做对也不算会。
    for (const n of [0, 1, 2]) {
      at(n);
      expect(tasks.suggestedPractice('/none').recommended).toEqual([]);
      expect(tasks.startSuggestedPractice('/none', crypto.randomUUID()).ok).toBe(false);
    }
    at(1);
    expect(tasks.suggestedPractice('/none').redo).toEqual({ dueCount: 0, nextDay: ymd(day(3)), nextCount: 3 });
    // 没到期的题仍可自己选题提前练。
    expect(tasks.suggestedPractice('/none').others.map(card => card.id).sort()).toEqual([...ids].sort());

    // 第 3 天到期，当天做对就算数（距录入 3 天）。
    at(3);
    expect(learningRedoOverview()).toMatchObject({ dueCount: 3 });
    expect(tasks.suggestedPractice('/none').dueTotal).toBe(3);
    const p1 = startSuggested();
    doAll(p1, day(3));
    expect(statuses(ids)).toEqual(['temporarily_mastered', 'temporarily_mastered', 'temporarily_mastered']);
    const summary = getLearningReturnSummary(p1)!;
    expect(summary.nextConfirmOn).toBe(ymd(day(13)));
    expect(summary.nextRedoOn).toBe(ymd(day(13)));

    // 确认日之前不排。
    for (const n of [7, 12]) { at(n); expect(tasks.suggestedPractice('/none').recommended).toEqual([]); }
    at(12); expect(learningRedoOverview()).toEqual({ dueCount: 0, nextDay: ymd(day(13)), nextCount: 3 });

    // 确认日之后才打开：确认题排进来，当天做对 → 稳定掌握。
    at(20);
    expect(tasks.suggestedPractice('/none').recommended.map(card => card.reason)).toEqual(Array(3).fill('上次做对了，到了再确认一次的时候'));
    doAll(startSuggested(), day(20));
    expect(statuses(ids)).toEqual(['stably_mastered', 'stably_mastered', 'stably_mastered']);
    expect(masteryEvents().filter(event => event.to_status === 'temporarily_mastered')).toHaveLength(3);
    expect(masteryEvents().filter(event => event.to_status === 'stably_mastered')).toHaveLength(3);
    at(40); expect(tasks.suggestedPractice('/none').recommended).toHaveLength(0);
  });

  it('到期确认轮当天建包、当天做对，不会把暂时掌握降回已作答', () => {
    const ids = seedPracticeItems(3);
    at(3); doAll(startSuggested(), day(3));
    expect(statuses(ids)).toEqual(Array(3).fill('temporarily_mastered'));

    at(13);
    const p2 = startSuggested();
    doAll(p2, day(13));
    expect(statuses(ids)).toEqual(Array(3).fill('stably_mastered'));
    expect(masteryEvents().some(event => event.from_status === 'temporarily_mastered' && event.to_status === 'attempted')).toBe(false);
  });

  it('做错或看提示做对：上次作答 + 3 天再排，到那天独立做对就算数', () => {
    const [wrong, helped] = seedPracticeItems(2) as [string, string];
    at(3);
    const p1 = startSuggested();
    expect(submitLearningReturns(p1, { results: [
      { itemId: wrong, completion: 'independent', correct: false, performedOn: ymd(day(3)) },
      { itemId: helped, completion: 'hint1', correct: true, performedOn: ymd(day(3)) },
    ] }).ok).toBe(true);
    expect(statuses([wrong, helped])).toEqual(['needs_recheck', 'needs_recheck']);
    for (const n of [4, 5]) { at(n); expect(tasks.suggestedPractice('/none').recommended).toEqual([]); }
    at(6);
    expect(tasks.suggestedPractice('/none').recommended.map(card => card.reason)).toEqual(Array(2).fill('上次练习没独立做对'));
    doAll(startSuggested(), day(6));
    expect(statuses([wrong, helped])).toEqual(['temporarily_mastered', 'temporarily_mastered']);
  });

  it('确认轮离上次作答不足 3 天（手动提前选）时保持暂时掌握，不降级也不升级', () => {
    const [id] = seedPracticeItems(1) as [string];
    at(4); doAll(startSuggested(), day(4));
    expect(status(id)).toBe('temporarily_mastered');
    const due = (getDb().prepare('SELECT next_review_at FROM error_item WHERE id=?').get(id) as { next_review_at: string }).next_review_at;

    // 模拟已有数据里的确认轮包：距上次作答只隔 1 天就做了。
    at(5);
    getDb().prepare('UPDATE error_item SET next_review_at=? WHERE id=?').run(ymd(day(5)), id);
    const p2 = startSuggested();
    doAll(p2, day(5));
    expect(status(id)).toBe('temporarily_mastered');
    expect(masteryEvents().map(event => event.to_status)).toEqual(['temporarily_mastered']);
    expect(due).toBe(ymd(day(14)));
  });

  it('当天录入、当天做对仍然不算掌握（不削弱「当天做对不算掌握」）', () => {
    const [id] = seedPracticeItems(1) as [string];
    // 自己选题提前练：当天做对只算 attempted，3 天后再排。
    at(0); doAll(startEarly([id]), day(0));
    expect(status(id)).toBe('attempted');
    at(1); expect(tasks.suggestedPractice('/none').recommended).toEqual([]);
    at(3); expect(tasks.suggestedPractice('/none').recommended.map(card => card.id)).toEqual([id]);
    // 晚几天才上传当天的作答，也不算延迟。
    at(5);
    const [late] = seedPracticeItems(1) as [string];
    getDb().prepare('UPDATE error_item SET created_at=? WHERE id=?').run(day(5).toISOString(), late);
    const p2 = startEarly([late]);
    at(8);
    const result = submitLearningReturns(p2, { results: [{ itemId: late, completion: 'independent', correct: true, performedOn: ymd(day(5)) }] });
    expect(result.ok && result.results[0]).toMatchObject({ ok: true, toStatus: 'attempted' });
  });
});

describe('「今天该做」队列', () => {
  it('每天最多 5 道，到期多的顺延；重练题优先，到期的新错题至少放 1 道', () => {
    const fresh = seedPracticeItems(8);
    at(3);
    // 6 道做错 → 第 6 天和 2 道新错题一起到期。
    const first = startEarly(fresh.slice(0, 6));
    doAll(first, day(3), () => false);
    at(6);
    const queue = tasks.suggestedPractice('/none');
    expect(queue.recommended).toHaveLength(5);
    expect(queue.dueTotal).toBe(8);
    expect(queue.recommended.filter(card => card.tier === 1)).toHaveLength(4);
    expect(queue.recommended.filter(card => card.tier === 4)).toHaveLength(1);
    expect(queue.others).toHaveLength(3);
    // 首页提醒与队列同一个口径（到期总数，界面最多说 5 道）。
    expect(learningRedoOverview().dueCount).toBe(8);
  });
});

describe('P0-3 回报里的再做日期', () => {
  it('同一份练习里各题日期不一时给出最早和最晚，不只给一个日期', () => {
    const ids = seedPracticeItems(2);
    at(0); const p1 = startEarly(ids); const [a, b] = packetItems(p1) as [string, string];
    expect(submitLearningReturns(p1, { results: [{ itemId: a, completion: 'independent', correct: true, performedOn: ymd(day(0)) }] }).ok).toBe(true);
    at(1);
    expect(submitLearningReturns(p1, { results: [{ itemId: b, completion: 'independent', correct: true, performedOn: ymd(day(1)) }] }).ok).toBe(true);
    const summary = getLearningReturnSummary(p1)!;
    expect(summary.pendingRedoOn).toBe(ymd(day(3)));
    expect(summary.pendingRedoLastOn).toBe(ymd(day(4)));
    expect(summary.redoDays).toEqual([ymd(day(3)), ymd(day(4))]);
  });

  it('晚几天才补录当天的作答：再做日期已到，回报日期早于今天', () => {
    const ids = seedPracticeItems(1);
    at(0); const p1 = startEarly(ids);
    at(5); doAll(p1, day(0));
    const summary = getLearningReturnSummary(p1)!;
    expect(summary.redoDays).toEqual([ymd(day(3))]);
    expect(summary.nextRedoOn! <= ymd(day(5))).toBe(true);
    expect(learningRedoOverview()).toMatchObject({ dueCount: 1 });
  });
});

describe('P0-3 积压：40 道新错题每天按「今天该做」练', () => {
  it('每天最多 5 道，新错题每天都能轮到，做对的进入暂时掌握', () => {
    const ids = seedPracticeItems(40);
    const seen = new Set<string>();
    for (let n = 3; n < 17; n++) {
      at(n);
      const packetId = startSuggested();
      const picked = packetItems(packetId);
      expect(picked.length).toBeLessThanOrEqual(5);
      const fresh = picked.filter(id => !seen.has(id));
      // 只要还有没练过的题，每天至少有 1 道新题。
      if (seen.size < ids.length) expect(fresh.length).toBeGreaterThanOrEqual(1);
      picked.forEach(id => seen.add(id));
      // 第 1 道做错，其余做对（复现脚本的做法）。
      doAll(packetId, day(n), index => index !== 0);
    }
    expect(seen.size).toBeGreaterThanOrEqual(30);
    // 到期才排，所以排进来的题做对都算数：没有一道停在「当天做对不算」。
    expect(ids.filter(id => status(id) === 'attempted')).toEqual([]);
    expect(ids.filter(id => status(id) === 'temporarily_mastered').length).toBeGreaterThanOrEqual(20);
  });
});

describe('P0-3 稳定掌握路径', () => {
  it('第 0 天录入 → 第 4 天做对 → 第 14 天到期建包 → 第 17 天做对 → 稳定掌握', () => {
    const [id] = seedPracticeItems(1) as [string];
    at(4); const p1 = startSuggested(); doAll(p1, day(4));
    expect(status(id)).toBe('temporarily_mastered');
    at(14); const p2 = startSuggested();
    at(17); doAll(p2, day(17));
    expect(status(id)).toBe('stably_mastered');
    expect(masteryEvents().map(event => event.to_status)).toEqual(['temporarily_mastered', 'stably_mastered']);
    // 稳定掌握后不再出现在建议里（长期抽查是另一项 P2）。
    at(30); expect(tasks.suggestedPractice('/none').recommended).toHaveLength(0);
  });

  it('提前练过一次的题，到期再做同样能到稳定掌握', () => {
    const [id] = seedPracticeItems(1) as [string];
    at(0); doAll(startEarly([id]), day(0));
    at(3); doAll(startSuggested(), day(3));
    expect(status(id)).toBe('temporarily_mastered');
    at(13); doAll(startSuggested(), day(13));
    expect(status(id)).toBe('stably_mastered');
  });
});
