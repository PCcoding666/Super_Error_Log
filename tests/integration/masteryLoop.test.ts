/**
 * P0-3 掌握闭环的日历模拟（合成数据，mock AI）。
 * 来源：生产就绪排查 2026-10-22 的 masteryLoop / backlog / stable 复现脚本。
 * 规则：当天做对不算掌握；延迟从「这道题上一次作答日 / 录入日」算，而不是练习包生成日；
 * 确认轮先判轮次再判天数，不降级；当场做对的题冷却 3 天，积压的新错题轮得到。
 */
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../src/db/connection.js';
import { learningRedoOverview } from '../../src/learning/queries.js';
import * as tasks from '../../src/v2/practiceTasks.js';
import { getLearningReturnSummary, submitLearningReturns } from '../../src/v2/returnService.js';
import { clearPracticeFixtures, seedPracticeItems } from '../helpers/practiceTask.js';

/** 2026-10-22 + n 天，本地 20:00（晚自习后）。 */
const day = (n: number): Date => new Date(2026, 9, 22 + n, 20, 0, 0);
const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const at = (n: number): void => { vi.setSystemTime(day(n)); };

/** 接受首页建议（「就练这 3 道」），并像打印/开始练习那样写下生成时间。 */
function startSuggested(): string {
  const result = tasks.startSuggestedPractice('/none', crypto.randomUUID());
  if (!result.ok) throw new Error(result.message);
  getDb().prepare("UPDATE review_packet SET status='generated', generated_at=? WHERE id=?").run(new Date().toISOString(), result.detail.id);
  return result.detail.id;
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

describe('P0-3 默认流程（接受建议、当天做完）能走到掌握', () => {
  it('当天做对只算 attempted；隔 3 天以上再做对 → 暂时掌握；到期确认 → 稳定掌握', () => {
    const ids = seedPracticeItems(3);

    at(0); const p1 = startSuggested(); doAll(p1, day(0));
    expect(statuses(ids)).toEqual(['attempted', 'attempted', 'attempted']);
    expect(masteryEvents()).toEqual([]);
    // 练完明确告诉学生哪天再做：上次作答 + 3 天。
    const summary0 = getLearningReturnSummary(p1)!;
    expect(summary0.pendingRedoOn).toBe(ymd(day(3)));
    expect(summary0.nextRedoOn).toBe(ymd(day(3)));

    // 第二天：同样 3 道在冷却期，不再推荐，也不会被「就练这 3 道」当天又做一遍。
    at(1);
    expect(tasks.suggestedPractice('/none').recommended).toEqual([]);
    expect(tasks.suggestedPractice('/none').redo).toEqual({ dueCount: 0, nextDay: ymd(day(3)), nextCount: 3 });
    expect(tasks.startSuggestedPractice('/none', crypto.randomUUID()).ok).toBe(false);

    // 第 4 天：冷却结束，首页提示到期，建包当天做对 → 暂时掌握（距上次作答 4 天，与建包日无关）。
    at(4);
    expect(learningRedoOverview()).toMatchObject({ dueCount: 3 });
    const p2 = startSuggested();
    doAll(p2, day(4));
    expect(statuses(ids)).toEqual(['temporarily_mastered', 'temporarily_mastered', 'temporarily_mastered']);
    const summary4 = getLearningReturnSummary(p2)!;
    expect(summary4.nextConfirmOn).toBe(ymd(day(14)));
    expect(summary4.nextRedoOn).toBe(ymd(day(14)));

    // 确认日之前不推荐。
    for (const n of [8, 12]) { at(n); expect(tasks.suggestedPractice('/none').recommended).toEqual([]); }
    at(12); expect(learningRedoOverview()).toEqual({ dueCount: 0, nextDay: ymd(day(14)), nextCount: 3 });

    // 第 20 天：到期确认轮，建包当天做对 → 稳定掌握。
    at(20);
    expect(tasks.suggestedPractice('/none').recommended.map(card => card.reason)).toEqual(Array(3).fill('上次做对了，到了再确认一次的时候'));
    doAll(startSuggested(), day(20));
    expect(statuses(ids)).toEqual(['stably_mastered', 'stably_mastered', 'stably_mastered']);
    expect(masteryEvents().filter(event => event.to_status === 'temporarily_mastered')).toHaveLength(3);
    expect(masteryEvents().filter(event => event.to_status === 'stably_mastered')).toHaveLength(3);
  });

  it('到期确认轮当天建包、当天做对，不会把暂时掌握降回已作答', () => {
    const ids = seedPracticeItems(3);
    at(0); const p1 = startSuggested();
    at(4); doAll(p1, day(4));
    expect(statuses(ids)).toEqual(Array(3).fill('temporarily_mastered'));

    at(14);
    const p2 = startSuggested();
    doAll(p2, day(14));
    expect(statuses(ids)).toEqual(Array(3).fill('stably_mastered'));
    expect(masteryEvents().some(event => event.from_status === 'temporarily_mastered' && event.to_status === 'attempted')).toBe(false);
  });

  it('确认轮离上次作答不足 3 天（手动提前选）时保持暂时掌握，不降级也不升级', () => {
    const [id] = seedPracticeItems(1) as [string];
    at(0); const p1 = startSuggested();
    at(4); doAll(p1, day(4));
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
    at(0); const p1 = startSuggested();
    doAll(p1, day(0));
    expect(status(id)).toBe('attempted');
    // 晚几天才上传当天的作答，也不算延迟。
    at(5);
    const [late] = seedPracticeItems(1) as [string];
    getDb().prepare('UPDATE error_item SET created_at=? WHERE id=?').run(day(5).toISOString(), late);
    at(5); const p2 = tasks.startSuggestedPractice('/none', crypto.randomUUID());
    if (!p2.ok) throw new Error(p2.message);
    getDb().prepare("UPDATE review_packet SET status='generated', generated_at=? WHERE id=?").run(day(5).toISOString(), p2.detail.id);
    at(8);
    const result = submitLearningReturns(p2.detail.id, { results: [{ itemId: late, completion: 'independent', correct: true, performedOn: ymd(day(5)) }] });
    expect(result.ok && result.results[0]).toMatchObject({ ok: true, toStatus: 'attempted' });
  });
});

describe('P0-3 回报里的再做日期', () => {
  it('同一份练习里各题日期不一时给出最早和最晚，不只给一个日期', () => {
    seedPracticeItems(2);
    at(0); const p1 = startSuggested(); const [a, b] = packetItems(p1) as [string, string];
    expect(submitLearningReturns(p1, { results: [{ itemId: a, completion: 'independent', correct: true, performedOn: ymd(day(0)) }] }).ok).toBe(true);
    at(1);
    expect(submitLearningReturns(p1, { results: [{ itemId: b, completion: 'independent', correct: true, performedOn: ymd(day(1)) }] }).ok).toBe(true);
    const summary = getLearningReturnSummary(p1)!;
    expect(summary.pendingRedoOn).toBe(ymd(day(3)));
    expect(summary.pendingRedoLastOn).toBe(ymd(day(4)));
    expect(summary.redoDays).toEqual([ymd(day(3)), ymd(day(4))]);
  });

  it('晚几天才补录当天的作答：再做日期已到，回报日期早于今天', () => {
    seedPracticeItems(1);
    at(0); const p1 = startSuggested();
    at(5); doAll(p1, day(0));
    const summary = getLearningReturnSummary(p1)!;
    expect(summary.redoDays).toEqual([ymd(day(3))]);
    expect(summary.nextRedoOn! <= ymd(day(5))).toBe(true);
    expect(learningRedoOverview()).toMatchObject({ dueCount: 1 });
  });
});

describe('P0-3 积压：40 道新错题每天练 3 道', () => {
  it('当场做对的题冷却 3 天，新错题每天都能轮到', () => {
    const ids = seedPracticeItems(40);
    const seen = new Set<string>();
    for (let n = 0; n < 14; n++) {
      at(n);
      const packetId = startSuggested();
      const picked = packetItems(packetId);
      const fresh = picked.filter(id => !seen.has(id));
      // 只要还有没练过的题，每天至少有 1 道新题。
      if (seen.size < ids.length) expect(fresh.length).toBeGreaterThanOrEqual(1);
      picked.forEach(id => seen.add(id));
      // 第 1 道做错，其余当天做对（复现脚本的做法）。
      doAll(packetId, day(n), index => index !== 0);
    }
    // 原来 14 天只练到同样 3 道；现在至少练到一半以上的积压。
    expect(seen.size).toBeGreaterThanOrEqual(20);
    // 同时：冷却到期后再做对的题能进入暂时掌握。
    expect(ids.some(id => status(id) === 'temporarily_mastered')).toBe(true);
  });
});

describe('P0-3 稳定掌握路径', () => {
  it('建包第 0 天 → 第 4 天做对 → 第 14 天到期建包 → 第 17 天做对 → 稳定掌握', () => {
    const [id] = seedPracticeItems(1) as [string];
    at(0); const p1 = startSuggested();
    at(4); doAll(p1, day(4));
    expect(status(id)).toBe('temporarily_mastered');
    at(14); const p2 = startSuggested();
    at(17); doAll(p2, day(17));
    expect(status(id)).toBe('stably_mastered');
    expect(masteryEvents().map(event => event.to_status)).toEqual(['temporarily_mastered', 'stably_mastered']);
    // 稳定掌握后不再出现在建议里（长期抽查是另一项 P2）。
    at(30); expect(tasks.suggestedPractice('/none').recommended).toHaveLength(0);
  });

  it('默认流程（每次建包当天就做）同样能到稳定掌握', () => {
    const [id] = seedPracticeItems(1) as [string];
    at(0); doAll(startSuggested(), day(0));
    at(3); doAll(startSuggested(), day(3));
    expect(status(id)).toBe('temporarily_mastered');
    at(13); doAll(startSuggested(), day(13));
    expect(status(id)).toBe('stably_mastered');
  });
});
