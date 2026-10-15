/**
 * Slice C 集成测试：回传 → 掌握度 → 趋势 → 家长聚合。
 * 覆盖 J6/J7/J8：延迟独立重做才算掌握、确认轮、复发预警、家长只见聚合。
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { MockAiProvider } from '../../src/ai/mockProvider.js';
import { setAiProviderForTest } from '../../src/ai/index.js';
import { getDb, now } from '../../src/db/connection.js';
import { createBatch, processBatch } from '../../src/services/batchService.js';
import { archiveItem, correctItem, listItems, submitReflection } from '../../src/services/itemService.js';
import { computeRecommendations, createPacket, packetItems } from '../../src/services/planService.js';
import { recordAttempt } from '../../src/services/attemptService.js';
import { masteryTrend, parentAggregate, recurrenceAlerts, weakTags } from '../../src/services/trendService.js';
import { createProfile } from '../../src/services/studentService.js';
import { WEEK1_DIR } from '../../src/fixtures/generate.js';
import type { Subject } from '../../src/domain/types.js';

function loadFixtures(): Array<{ filename: string; mime: string; buffer: Buffer }> {
  return fs.readdirSync(WEEK1_DIR).sort().map((filename) => ({
    filename,
    mime: filename.endsWith('.pdf') ? 'application/pdf' : filename.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
    buffer: fs.readFileSync(path.join(WEEK1_DIR, filename)),
  }));
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString();
}

describe('Slice C：回传到掌握', () => {
  let studentId = '';
  let packetId = '';
  let packet2Id = '';

  beforeAll(async () => {
    setAiProviderForTest(new MockAiProvider());
    studentId = createProfile({ nickname: '掌握测试', subjects: ['数学', '物理', '化学'], weekendPref: '周六上午' }).id;
    const { batchId } = await createBatch(studentId, loadFixtures());
    await processBatch(batchId);
    for (const item of listItems(studentId).filter((i) => i.status === 'needs_review')) {
      correctItem(item.id, {
        subject: (item.subject ?? '数学') as Subject,
        chapter: '单元',
        knowledgeTags: JSON.parse(item.knowledge_tags) as string[],
        questionType: '计算题',
        isKeyGap: false,
      });
    }
    for (const item of listItems(studentId).filter((i) => i.status === 'ready_for_reflection')) {
      submitReflection(item.id, {
        attemptState: '完全不会',
        cause: '知识概念',
        masteryFeeling: 1,
        reviewValue: '必须再做',
      }, 'student');
    }
    const recs = computeRecommendations(studentId, new Date());
    packetId = createPacket(studentId, recs.slice(0, 8).map((r) => r.itemId)).packetId!;
    // 直接置为 packet_generated（PDF 生成已在 Slice B 覆盖）
    getDb().prepare("UPDATE review_packet SET status = 'generated', generated_at = ? WHERE id = ?").run(now(), packetId);
    getDb()
      .prepare("UPDATE error_item SET status = 'packet_generated', updated_at = ? WHERE id IN (SELECT item_id FROM review_packet_item WHERE packet_id = ?)")
      .run(now(), packetId);
  }, 60000);

  it('回传归属校验：非学生本人、非本包题目被拒绝', () => {
    const item = packetItems(packetId)[0]!;
    const notStudent = recordAttempt(packetId, item.id, { completion: 'independent', correct: true }, 'parent');
    expect(notStudent.ok).toBe(false);

    const outsider = listItems(studentId).find((i) => i.status === 'eligible_for_review')!;
    const notInPacket = recordAttempt(packetId, outsider.id, { completion: 'independent', correct: true }, 'student');
    expect(notInPacket.ok).toBe(false);
    expect(notInPacket.error).toContain('不在此复习包');
  });

  it('当场做对不算掌握：daysSincePacket < 3 → attempted', () => {
    const item = packetItems(packetId)[0]!;
    const r = recordAttempt(packetId, item.id, { completion: 'independent', correct: true }, 'student');
    expect(r.ok).toBe(true);
    expect(r.toStatus).toBe('attempted');
    const ev = getDb()
      .prepare("SELECT COUNT(*) AS n FROM mastery_event WHERE item_id = ? AND to_status IN ('temporarily_mastered','stably_mastered')")
      .get(item.id) as { n: number };
    expect(ev.n).toBe(0); // 当场做对不产生掌握事件
  });

  it('提示/不确定/做错/未完成 → needs_recheck', () => {
    const items = packetItems(packetId);
    const cases = [
      { completion: 'hint_used', correct: true },
      { completion: 'unsure', correct: true },
      { completion: 'independent', correct: false },
      { completion: 'unfinished', correct: false },
    ] as const;
    cases.forEach((c, i) => {
      const r = recordAttempt(packetId, items[i + 1]!.id, { ...c }, 'student');
      expect(r.ok).toBe(true);
      expect(r.toStatus).toBe('needs_recheck');
    });
  });

  it('延迟 4 天独立做对 → temporarily_mastered，写入掌握事件与确认日期', () => {
    getDb().prepare('UPDATE review_packet SET generated_at = ? WHERE id = ?').run(daysAgo(4), packetId);
    const item = packetItems(packetId)[5]!;
    const r = recordAttempt(packetId, item.id, { completion: 'independent', correct: true }, 'student');
    expect(r.toStatus).toBe('temporarily_mastered');

    const row = getDb().prepare('SELECT status, next_review_at FROM error_item WHERE id = ?').get(item.id) as {
      status: string; next_review_at: string | null;
    };
    expect(row.status).toBe('temporarily_mastered');
    expect(row.next_review_at).toBeTruthy();
    const waitDays = (new Date(row.next_review_at!).getTime() - Date.now()) / 86400000;
    expect(waitDays).toBeGreaterThan(6);
    expect(waitDays).toBeLessThan(15);

    const ev = getDb().prepare('SELECT from_status, to_status FROM mastery_event WHERE item_id = ?').get(item.id) as {
      from_status: string; to_status: string;
    };
    expect(ev.to_status).toBe('temporarily_mastered');
  });

  it('同包重复回传被拒绝（防止刷分直通稳定掌握）', () => {
    const item = packetItems(packetId)[0]!; // 已回传为 attempted
    const again = recordAttempt(packetId, item.id, { completion: 'independent', correct: true }, 'student');
    expect(again.ok).toBe(false);
    expect(again.error).toContain('已回传');
    const attempts = getDb()
      .prepare('SELECT COUNT(*) AS n FROM review_attempt WHERE packet_id = ? AND item_id = ?')
      .get(packetId, item.id) as { n: number };
    expect(attempts.n).toBe(1);
  });

  it('当场做对（attempted）的题目下周仍进入推荐，附延迟验证理由', () => {
    const item = packetItems(packetId)[0]!; // attempted
    const recs = computeRecommendations(studentId, new Date());
    const rec = recs.find((r) => r.itemId === item.id);
    expect(rec).toBeTruthy();
    expect(rec!.reasons[0]).toContain('当场做对不计掌握');
  });

  it('趋势与复发预警：薄弱标签、同错因复发、状态分布', () => {
    const tags = weakTags(studentId);
    expect(tags.length).toBeGreaterThan(0);
    expect(tags[0]!.count).toBeGreaterThanOrEqual(2);

    const alerts = recurrenceAlerts(studentId);
    expect(alerts.some((a) => a.kind === 'tag' && a.count >= 2)).toBe(true);
    expect(alerts.some((a) => a.kind === 'cause' && a.name === '知识概念' && a.count >= 8)).toBe(true);

    const trend = Object.fromEntries(masteryTrend(studentId).map((t) => [t.status, t.n]));
    expect(trend['temporarily_mastered']).toBe(1);
    expect(trend['needs_recheck']).toBe(4);
    expect(trend['attempted']).toBe(1);
  });

  it('归档门禁：有复发证据拒绝归档；无复发且学生判没必要可归档', () => {
    const recurring = listItems(studentId).find((i) => i.status === 'eligible_for_review')!;
    // 反思已是 必须再做 → 直接拒绝
    const deny = archiveItem(recurring.id);
    expect(deny.ok).toBe(false);

    // 构造无复发题：独立知识点标签 + 学生判没必要
    submitReflection(recurring.id, {
      attemptState: '本来会但审题计算书写失误',
      cause: '审题遗漏',
      masteryFeeling: 3,
      reviewValue: '没必要再做',
    }, 'student');
    getDb().prepare('UPDATE error_item SET knowledge_tags = ? WHERE id = ?').run(JSON.stringify(['绝版知识点xyz']), recurring.id);
    const allow = archiveItem(recurring.id);
    expect(allow.ok).toBe(true);
    expect(listItems(studentId).find((i) => i.id === recurring.id)!.status).toBe('archived_not_worth_review');
  });

  it('家长聚合：只有数字与标签名，不含题目原文/反思/提示/答案', () => {
    const agg = parentAggregate(studentId);
    expect(agg.weeklyCompletion.length).toBeGreaterThan(0);
    expect(agg.weeklyCompletion[0]!.total).toBe(8);
    expect(agg.weeklyCompletion[0]!.attempted).toBe(6); // 6 题有作答，2 题未动
    expect(agg.subjectMastery.length).toBeGreaterThan(0);
    expect(agg.topWeakTags.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(agg);
    const sample = listItems(studentId)[0]!;
    if (sample.text_excerpt) expect(serialized).not.toContain(sample.text_excerpt);
    expect(serialized).not.toContain('提示：');
    expect(serialized).not.toContain('标准答案');
    expect(serialized).not.toContain('完全不会'); // 反思作答状态不外泄
  });

  it('确认轮（新复习包）再次独立做对 → stably_mastered', () => {
    const items = packetItems(packetId);
    const confirmItem = items[5]!; // temporarily_mastered
    // 到期：把确认日期拨到过去
    getDb().prepare('UPDATE error_item SET next_review_at = ? WHERE id = ?').run(daysAgo(1), confirmItem.id);
    // 确认轮题目应出现在推荐中，且带确认理由
    const recs = computeRecommendations(studentId, new Date());
    const rec = recs.find((r) => r.itemId === confirmItem.id);
    expect(rec).toBeTruthy();
    expect(rec!.reasons[0]).toContain('确认轮');

    // 确认题 + 4 道需重做题组成第 2 个包（满足最少 5 道）
    const p2 = createPacket(studentId, [confirmItem.id, ...items.slice(1, 5).map((i) => i.id)]);
    expect(p2.ok).toBe(true);
    packet2Id = p2.packetId!;
    // 确认题保持 temporarily_mastered，其余题进入 scheduled
    expect((getDb().prepare('SELECT status FROM error_item WHERE id = ?').get(confirmItem.id) as { status: string }).status)
      .toBe('temporarily_mastered');
    getDb().prepare("UPDATE review_packet SET status = 'generated', generated_at = ? WHERE id = ?").run(daysAgo(10), packet2Id);

    const r = recordAttempt(packet2Id, confirmItem.id, { completion: 'independent', correct: true }, 'student');
    expect(r.ok).toBe(true);
    expect(r.toStatus).toBe('stably_mastered');
    const evs = getDb().prepare('SELECT to_status FROM mastery_event WHERE item_id = ? ORDER BY created_at').all(confirmItem.id) as Array<{ to_status: string }>;
    expect(evs.map((e) => e.to_status)).toEqual(['temporarily_mastered', 'stably_mastered']);
  });

  it('未生成 PDF 的复习包拒绝回传', () => {
    const item = packetItems(packetId)[0]!; // attempted，可被重新安排
    getDb()
      .prepare("INSERT INTO review_packet (id, student_id, week, status, planned_date, created_at) VALUES (?,?,?,?,?,?)")
      .run('pkt_manual', studentId, '2099-W01', 'scheduled', null, now());
    getDb().prepare('INSERT INTO review_packet_item (packet_id, item_id, position) VALUES (?,?,0)').run('pkt_manual', item.id);
    const r = recordAttempt('pkt_manual', item.id, { completion: 'independent', correct: true }, 'student');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('尚未生成');
  });

  it('全部题目回传后复习包状态变为 returned，且不再接受回传', () => {
    const items = packetItems(packetId);
    for (const it of items.slice(1, 5)) { // packet2 剩余 4 道（确认题已回传）
      const r = recordAttempt(packet2Id, it.id, { completion: 'independent', correct: true }, 'student');
      expect(r.ok).toBe(true);
    }
    const st = getDb().prepare('SELECT status FROM review_packet WHERE id = ?').get(packet2Id) as { status: string };
    expect(st.status).toBe('returned');
    const again = recordAttempt(packet2Id, items[1]!.id, { completion: 'independent', correct: true }, 'student');
    expect(again.ok).toBe(false);
  });

  it('重新生成 PDF 不回退已作答/已掌握题目状态', async () => {
    const { generatePacketPdf } = await import('../../src/services/pdfService.js');
    const rows = () =>
      Object.fromEntries(
        (getDb().prepare('SELECT id, status FROM error_item').all() as Array<{ id: string; status: string }>).map((r) => [r.id, r.status]),
      );
    const before = rows();
    const r = await generatePacketPdf(packetId);
    expect(r.ok).toBe(true);
    const after = rows();
    // scheduled → packet_generated 是正常推进；其余状态必须原样保留
    for (const [id, status] of Object.entries(before)) {
      if (status !== 'scheduled') expect(after[id]).toBe(status);
    }
  }, 90000);
});
