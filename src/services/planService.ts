import { getDb, newId, now } from '../db/connection.js';
import { scoreItem } from '../domain/scoring.js';
import { isoWeekKey, plannedDateForPacket, PLAN_MAX, PLAN_MIN, selectWeeklyPlan } from '../domain/scheduling.js';
import type { Cause, MasteryFeeling, ReviewValue } from '../domain/types.js';
import { audit } from './eventLog.js';
import { getDiagnosis, listItems, recurrenceCount, type ItemRow } from './itemService.js';
import { getEvidence, assertEvidenceReady } from './evidenceService.js';
import { isDemoAsset } from './assetOrigin.js';

/** 可安排的候选：待复习/需重做/当场做过待延迟验证 + 确认轮到期的暂时掌握题 */
function reviewableItems(studentId: string): ItemRow[] {
  const nowIso = now();
  const active = new Set((getDb().prepare(`SELECT rpi.item_id FROM review_packet_item rpi JOIN review_packet rp ON rp.id=rpi.packet_id WHERE rp.student_id=? AND rp.status IN ('scheduled','generated') AND NOT EXISTS (SELECT 1 FROM review_attempt ra WHERE ra.packet_id=rpi.packet_id AND ra.item_id=rpi.item_id)`).all(studentId) as Array<{item_id:string}>).map(r => r.item_id));
  return listItems(studentId).filter(
    (i) =>
      !active.has(i.id) && hasReadyEvidence(i) && (i.status === 'eligible_for_review' ||
      i.status === 'needs_recheck' ||
      i.status === 'attempted' ||
      (i.status === 'temporarily_mastered' && i.next_review_at !== null && i.next_review_at <= nowIso)),
  );
}

function hasReadyEvidence(item: ItemRow): boolean {
  const evidence = getEvidence(item.id);
  if (!evidence) return isDemoAsset(item.asset_id);
  try { assertEvidenceReady(item.id, evidence); return true; } catch { return false; }
}

export interface Recommendation {
  itemId: string;
  shortId: string;
  subject: string | null;
  primaryTag: string | null;
  score: number;
  reasons: string[];
  conflict: boolean;
}

/** 计算本周候选题目的可解释评分 */
export function computeRecommendations(studentId: string, weekDate: Date): Recommendation[] {
  const db = getDb();
  const week = isoWeekKey(weekDate);
  const eligible = reviewableItems(studentId);

  return eligible.map((item: ItemRow) => {
    const diag = getDiagnosis(item.id);
    const tags = JSON.parse(item.knowledge_tags) as string[];
    const backlogMissed = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM review_packet_item rpi
           JOIN review_packet rp ON rp.id = rpi.packet_id
           LEFT JOIN review_attempt ra ON ra.item_id = rpi.item_id AND ra.packet_id = rp.id
           WHERE rpi.item_id = ? AND rp.status = 'generated' AND ra.id IS NULL`,
        )
        .get(item.id) as { n: number }
    ).n > 0;
    const result = scoreItem({
      cause: (diag?.cause as Cause | undefined) ?? null,
      reviewValue: (diag?.review_value as ReviewValue | undefined) ?? null,
      recurrenceCount: recurrenceCount(item.id),
      isKeyGap: item.is_key_gap === 1,
      masteryFeeling: (diag?.mastery_feeling as MasteryFeeling | undefined) ?? null,
      backlogMissed,
    });
    const reasons = item.status === 'temporarily_mastered'
      ? ['确认轮到期：验证是否稳定掌握', ...result.reasons]
      : item.status === 'attempted'
        ? ['当场做对不计掌握：需延迟独立重做验证', ...result.reasons]
        : result.reasons;
    db.prepare(
      'INSERT INTO review_recommendation (id, item_id, week, score, reasons, conflict_flag, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(newId('rec'), item.id, week, result.score, JSON.stringify(reasons), result.conflict ? 1 : 0, now());

    return {
      itemId: item.id,
      shortId: item.short_id ?? '?',
      subject: item.subject,
      primaryTag: tags[0] ?? null,
      score: result.score,
      reasons,
      conflict: result.conflict,
    };
  }).sort((a, b) => b.score - a.score || Number(b.conflict) - Number(a.conflict) || a.itemId.localeCompare(b.itemId));
}

export interface Packet {
  id: string;
  week: string;
  status: string;
  planned_date: string | null;
  pdf_path: string | null;
  generated_at: string | null;
  created_at: string;
}

/** 创建复习包：5–8 题；不足 5 道时允许全部纳入（notes 已在计划页提示） */
export function createPacket(studentId: string, itemIds: string[]): { ok: boolean; packetId?: string; error?: string } {
  if (!itemIds.length || new Set(itemIds).size !== itemIds.length) return { ok: false, error: '请选择不重复的题目，复习包不能为空' };
  const eligible = new Set(reviewableItems(studentId).map((i) => i.id));
  const valid = itemIds.filter((id) => eligible.has(id));
  if (valid.length !== itemIds.length) {
    return { ok: false, error: '包含不可安排的题目' };
  }
  if (valid.length > PLAN_MAX) {
    return { ok: false, error: `每周最多 ${PLAN_MAX} 道` };
  }
  if (valid.length < Math.min(PLAN_MIN, eligible.size)) {
    return { ok: false, error: `每周至少 ${PLAN_MIN} 道（候选不足时除外）` };
  }

  const db = getDb();
  const nowDate = new Date();
  const packetId = newId('pkt');
  db.prepare(
    'INSERT INTO review_packet (id, student_id, week, status, planned_date, created_at) VALUES (?,?,?,?,?,?)',
  ).run(packetId, studentId, isoWeekKey(nowDate), 'scheduled', plannedDateForPacket(nowDate), now());

  valid.forEach((itemId, i) => {
    const diag = getDiagnosis(itemId);
    const evidence = getEvidence(itemId);
    const coaching = evidence?.coaching?.value;
    const reference = evidence?.content.observations.filter(o => o.kind === 'reference_answer').map(o => o.text).join('\n');
    db.prepare(
      'INSERT INTO review_packet_item (packet_id, item_id, position, hint_text, answer_text) VALUES (?,?,?,?,?)',
    ).run(
      packetId,
      itemId,
      i,
      evidence ? (coaching ? coaching.hints.map((hint, index) => `提示${index + 1}：${hint}`).join('\n') : '尚未提供针对本题的提示。') : `演示提示：先回忆「${diag?.cause ?? '相关方法'}」的常见切入点，再动笔。`,
      evidence ? (coaching ? `AI参考（未经教师核验）：${coaching.answer}\n${coaching.solution}` : reference ? `图中参考答案（人工校对转录）：${reference}` : '尚未提供参考答案，请向老师或原练习册核对。') : '演示内容：标准答案请见原试卷/练习册。',
    );
    // 确认轮题目保持 temporarily_mastered，回传时据此判定确认作答
    db.prepare("UPDATE error_item SET status = 'scheduled', updated_at = ? WHERE id = ? AND status != 'temporarily_mastered'").run(now(), itemId);
  });

  audit('plan_confirmed', 'packet', packetId);
  return { ok: true, packetId };
}

export function getPacket(packetId: string): Packet | null {
  const row = getDb().prepare('SELECT * FROM review_packet WHERE id = ?').get(packetId) as Packet | undefined;
  return row ?? null;
}

export function packetItems(packetId: string): Array<ItemRow & { position: number; hint_text: string | null; answer_text: string | null }> {
  return getDb()
    .prepare(
      `SELECT ei.*, rpi.position, rpi.hint_text, rpi.answer_text
       FROM review_packet_item rpi JOIN error_item ei ON ei.id = rpi.item_id
       WHERE rpi.packet_id = ? ORDER BY rpi.position`,
    )
    .all(packetId) as unknown as Array<ItemRow & { position: number; hint_text: string | null; answer_text: string | null }>;
}
