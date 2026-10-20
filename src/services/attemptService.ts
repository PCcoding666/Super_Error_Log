import { getDb, newId, now } from '../db/connection.js';
import { confirmationDateFor } from '../domain/scheduling.js';
import { ATTEMPTABLE_STATUSES, statusAfterAttempt } from '../domain/stateMachine.js';
import { COMPLETION_LABEL, type Completion } from '../domain/types.js';
import { audit } from './eventLog.js';
import { getItem } from './itemService.js';
import { getPacket } from './planService.js';

export interface AttemptInput {
  completion: Completion;
  correct: boolean;
  stuckStep?: string;
  performedAt?: string;
  /** 提示等级（v2.0 T4d）：0 未看提示 / 1 一级 / 2 二级；缺省按 0 落库。不影响掌握判定。 */
  hintLevel?: 0 | 1 | 2;
}

interface CalendarDay {
  text: string;
  ordinal: number;
  date: Date;
}

function calendarDayText(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseCalendarDay(value: string): CalendarDay | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(0);
  utc.setUTCHours(0, 0, 0, 0);
  utc.setUTCFullYear(year, month - 1, day);
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null;
  const local = new Date(0);
  local.setHours(12, 0, 0, 0);
  local.setFullYear(year, month - 1, day);
  return { text: value, ordinal: utc.getTime() / 86_400_000, date: local };
}

function dayFromInstant(value: Date): CalendarDay | null {
  if (!Number.isFinite(value.getTime())) return null;
  return parseCalendarDay(calendarDayText(value));
}

/**
 * 记录一次回传作答并流转状态。
 * 掌握事件追加写入 mastery_event；失败/提示/未完成进入 needs_recheck。
 */
export function recordAttempt(
  packetId: string,
  itemId: string,
  input: AttemptInput,
  submittedBy: string,
): { ok: boolean; toStatus?: string; reason?: string; error?: string } {
  if (submittedBy !== 'student') {
    return { ok: false, error: '回传结果必须由学生本人提交' };
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: '回传输入无效' };
  }
  const runtimeInput = input as unknown as Record<string, unknown>;
  if (typeof runtimeInput.completion !== 'string' || !Object.hasOwn(COMPLETION_LABEL, runtimeInput.completion)) {
    return { ok: false, error: '完成情况无效' };
  }
  if (typeof runtimeInput.correct !== 'boolean') {
    return { ok: false, error: '对错结果必须是布尔值' };
  }
  if (
    runtimeInput.stuckStep !== undefined
    && (typeof runtimeInput.stuckStep !== 'string' || runtimeInput.stuckStep.length > 100)
  ) {
    return { ok: false, error: '卡住的步骤必须是 100 字以内的文本' };
  }
  if (runtimeInput.performedAt !== undefined && typeof runtimeInput.performedAt !== 'string') {
    return { ok: false, error: '实际作答日期必须是 YYYY-MM-DD 文本' };
  }
  if (
    runtimeInput.hintLevel !== undefined
    && (typeof runtimeInput.hintLevel !== 'number' || !Number.isInteger(runtimeInput.hintLevel)
      || runtimeInput.hintLevel < 0 || runtimeInput.hintLevel > 2)
  ) {
    return { ok: false, error: '提示等级必须是 0–2 的整数' };
  }
  const completion = runtimeInput.completion as Completion;
  const correct = runtimeInput.correct;
  const stuckStep = runtimeInput.stuckStep as string | undefined;
  const performedAt = runtimeInput.performedAt as string | undefined;
  const hintLevel = (runtimeInput.hintLevel as 0 | 1 | 2 | undefined) ?? 0;

  const db = getDb();
  const cancelled = db.prepare("SELECT 1 FROM practice_task WHERE packet_id=? AND lifecycle='cancelled'").get(packetId);
  if (cancelled) return {ok:false,error:'这份练习已取消，不能再记录作答'};
  const item = getItem(itemId);
  const packet = getPacket(packetId);
  if (!item || !packet) return { ok: false, error: '题目或复习包不存在' };

  const isInPacket = db
    .prepare('SELECT 1 AS x FROM review_packet_item WHERE packet_id = ? AND item_id = ?')
    .get(packetId, itemId);
  if (!isInPacket) return { ok: false, error: '该题不在此复习包中' };

  if (!ATTEMPTABLE_STATUSES.includes(item.status)) {
    return { ok: false, error: `状态「${item.status}」不可回传` };
  }
  if (packet.status !== 'generated') {
    return { ok: false, error: packet.status === 'returned' ? '该复习包已全部回传' : '复习包尚未生成 PDF，不能回传' };
  }
  const already = db
    .prepare('SELECT 1 AS x FROM review_attempt WHERE packet_id = ? AND item_id = ?')
    .get(packetId, itemId);
  if (already) return { ok: false, error: '该题在此复习包中已回传，确认轮请等下个复习包' };

  const hasRealEvidence = Boolean(db.prepare('SELECT 1 AS x FROM evidence_record WHERE item_id = ?').get(itemId));
  const rawPerformedAt = performedAt?.trim();
  if (hasRealEvidence && !rawPerformedAt) {
    return { ok: false, error: '真实题目必须填写纸上实际作答日期' };
  }
  const performedDay = parseCalendarDay(rawPerformedAt || calendarDayText(new Date()));
  if (!performedDay) return { ok: false, error: '实际作答日期必须是有效的 YYYY-MM-DD 日历日期' };
  const today = dayFromInstant(new Date())!;
  if (performedDay.ordinal > today.ordinal) return { ok: false, error: '实际作答日期不能是未来日期' };

  const generatedDay = dayFromInstant(new Date(packet.generated_at ?? ''));
  if (!generatedDay) return { ok: false, error: '复习包缺少首次打印日期，不能记录作答' };
  if (performedDay.ordinal < generatedDay.ordinal) {
    return { ok: false, error: '实际作答日期不能早于复习包首次打印日期' };
  }
  const daysSincePacket = performedDay.ordinal - generatedDay.ordinal;
  const isConfirmation = item.status === 'temporarily_mastered';
  const transition = statusAfterAttempt(item.status, {
    completion,
    correct,
    daysSincePacket,
    isConfirmation,
  });

  db.prepare(
    `INSERT INTO review_attempt
     (id, packet_id, item_id, completion, correct, stuck_step, submitted_by, performed_at, hint_level, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    newId('att'), packetId, itemId, completion, correct ? 1 : 0,
    stuckStep ?? null, 'student', performedDay.text, hintLevel, now(),
  );

  if (transition.to !== item.status) {
    let nextReviewAt: string | null = null;
    if (transition.to === 'temporarily_mastered') {
      nextReviewAt = confirmationDateFor(performedDay.date);
    }
    db.prepare('UPDATE error_item SET status = ?, next_review_at = ?, updated_at = ? WHERE id = ?')
      .run(transition.to, nextReviewAt, now(), itemId);
    db.prepare(
      'INSERT INTO mastery_event (id, item_id, from_status, to_status, reason, created_at) VALUES (?,?,?,?,?,?)',
    ).run(newId('mev'), itemId, item.status, transition.to, transition.reason, now());
    audit('mastery_changed', 'item', itemId);
  } else {
    db.prepare('UPDATE error_item SET updated_at = ? WHERE id = ?').run(now(), itemId);
  }
  audit('attempt_submitted', 'item', itemId);

  const remaining = db
    .prepare(
      `SELECT COUNT(*) AS n FROM review_packet_item rpi
       LEFT JOIN review_attempt ra ON ra.packet_id = rpi.packet_id AND ra.item_id = rpi.item_id
       WHERE rpi.packet_id = ? AND ra.id IS NULL`,
    )
    .get(packetId) as { n: number };
  if (remaining.n === 0) {
    db.prepare("UPDATE review_packet SET status = 'returned' WHERE id = ? AND status = 'generated'").run(packetId);
    audit('packet_returned', 'packet', packetId);
  }
  return { ok: true, toStatus: transition.to, reason: transition.reason };
}

export function attemptsForPacket(packetId: string): Array<{
  item_id: string; completion: string; correct: number; performed_at: string | null; created_at: string;
}> {
  return getDb()
    .prepare('SELECT item_id, completion, correct, performed_at, created_at FROM review_attempt WHERE packet_id = ?')
    .all(packetId) as Array<{
      item_id: string; completion: string; correct: number; performed_at: string | null; created_at: string;
    }>;
}
