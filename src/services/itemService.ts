import { getDb, newId, now } from '../db/connection.js';
import { canArchive, statusAfterReflection } from '../domain/stateMachine.js';
import type { Cause, ItemStatus, ReflectionInput, Subject } from '../domain/types.js';
import { isAdoptable, type ReflectionSuggestion } from '../domain/reflectionSuggestion.js';
import type { FieldSuggestion } from '../ai/provider.js';
import { getAiProvider } from '../ai/index.js';
import { audit } from './eventLog.js';
import { getEvidence, assertEvidenceReady } from './evidenceService.js';
import { isDemoAsset } from './assetOrigin.js';

export interface ItemRow {
  id: string;
  short_id: string | null;
  student_id: string;
  batch_id: string;
  asset_id: string;
  item_index: number;
  subject: string | null;
  chapter: string | null;
  knowledge_tags: string;
  question_type: string | null;
  status: ItemStatus;
  confidence: number;
  needs_correction: number;
  has_question_img: number;
  has_work_img: number;
  has_answer_img: number;
  has_teacher_note: number;
  text_excerpt: string | null;
  ai_suggestion: string | null;
  is_key_gap: number;
  next_review_at: string | null;
  archived_reason: string | null;
  created_at: string;
  updated_at: string;
}

export function getItem(id: string): ItemRow | null {
  const row = getDb().prepare('SELECT * FROM error_item WHERE id = ?').get(id) as ItemRow | undefined;
  return row ?? null;
}

export function getItemByShortId(shortId: string): ItemRow | null {
  const row = getDb().prepare('SELECT * FROM error_item WHERE short_id = ?').get(shortId) as ItemRow | undefined;
  return row ?? null;
}

export function listItems(studentId: string, filter: { status?: ItemStatus; subject?: string } = {}): ItemRow[] {
  let sql = 'SELECT * FROM error_item WHERE student_id = ?';
  const params: string[] = [studentId];
  if (filter.status) {
    sql += ' AND status = ?';
    params.push(filter.status);
  }
  if (filter.subject) {
    sql += ' AND subject = ?';
    params.push(filter.subject);
  }
  sql += ' ORDER BY created_at DESC';
  return getDb().prepare(sql).all(...params) as unknown as ItemRow[];
}

export function correctItem(
  itemId: string,
  fields: { subject: Subject; chapter: string; knowledgeTags: string[]; questionType: string; isKeyGap: boolean },
): void {
  if (getEvidence(itemId)) throw new Error('真实题请在证据校对页修改完整题干与作答');
  const item = getItem(itemId);
  if (!item || !isDemoAsset(item.asset_id)) throw new Error('旧真实条目缺少证据，请重新提取');
  const db = getDb();
  db.prepare(
    `UPDATE error_item SET subject = ?, chapter = ?, knowledge_tags = ?, question_type = ?,
     is_key_gap = ?, needs_correction = 0, status = 'ready_for_reflection', updated_at = ?
     WHERE id = ?`,
  ).run(
    fields.subject,
    fields.chapter,
    JSON.stringify(fields.knowledgeTags),
    fields.questionType,
    fields.isKeyGap ? 1 : 0,
    now(),
    itemId,
  );
  audit('item_corrected', 'item', itemId);
}

/** 学生提交四项最小反思。submittedBy 只能是 student——AI 不得代写。
 *  adoptedAi=true 表示学生看了 AI 建议后主动一键采纳（仍是学生提交行为），用于采纳率监控。 */
export function submitReflection(
  itemId: string,
  input: ReflectionInput,
  submittedBy: string,
  opts: { adoptedAi?: boolean } = {},
): { ok: boolean; error?: string } {
  if (submittedBy !== 'student') {
    return { ok: false, error: '反思必须由学生本人提交' };
  }
  const db = getDb();
  const item = getItem(itemId);
  if (!item) return { ok: false, error: '题目不存在' };
  const evidence = getEvidence(itemId);
  if (!evidence && !isDemoAsset(item.asset_id)) return { ok: false, error: '旧真实条目缺少证据，请重新提取并校对' };
  if (evidence && (!evidence.verified || item.status === 'needs_review')) return { ok: false, error: '请先校对真实题证据' };
  if (evidence) {
    try { assertEvidenceReady(itemId, evidence); }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : '裁图证据检查失败' }; }
  }

  db.prepare(
    `INSERT INTO error_diagnosis (id, item_id, attempt_state, cause, mastery_feeling, review_value, submitted_by, adopted_ai, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(newId('dia'), itemId, input.attemptState, input.cause, input.masteryFeeling, input.reviewValue, 'student', opts.adoptedAi ? 1 : 0, now());

  const t = statusAfterReflection(item.status);
  if (t.to !== item.status) {
    db.prepare('UPDATE error_item SET status = ?, updated_at = ? WHERE id = ?').run(t.to, now(), itemId);
  }
  audit('reflection_submitted', 'item', itemId);
  return { ok: true };
}

/**
 * 反思环节的 AI 建议装配。
 * 真实题：只给出诊断阶段的错因建议（其余字段无证据，不猜）→ 天然不可一键采纳。
 * 演示题（mock）：走 provider.suggestFields，可给出三项；掌握感永远不建议。
 */
export async function getReflectionSuggestion(item: ItemRow): Promise<(ReflectionSuggestion & { adoptable: boolean }) | null> {
  const evidence = getEvidence(item.id);
  if (evidence) {
    const d = evidence.diagnosis?.value;
    if (!d?.possibleCause) return null;
    const s: ReflectionSuggestion = { cause: { value: d.possibleCause, confidence: d.confidence } };
    return { ...s, adoptable: isAdoptable(s) };
  }
  if (!isDemoAsset(item.asset_id)) return null;
  let s: FieldSuggestion;
  try {
    s = await getAiProvider().suggestFields({
      itemId: item.id,
      textExcerpt: item.text_excerpt ?? '',
      subject: item.subject ?? undefined,
    });
  } catch {
    return null;
  }
  const out: ReflectionSuggestion = {};
  if (s.attemptState) out.attemptState = s.attemptState;
  if (s.possibleCause) out.cause = s.possibleCause;
  if (s.reviewValue) out.reviewValue = s.reviewValue;
  return { ...out, adoptable: isAdoptable(out) };
}

export function getDiagnosis(itemId: string): {
  attempt_state: string; cause: Cause; mastery_feeling: number; review_value: string; created_at: string;
} | null {
  const row = getDb()
    .prepare('SELECT * FROM error_diagnosis WHERE item_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(itemId) as { attempt_state: string; cause: Cause; mastery_feeling: number; review_value: string; created_at: string } | undefined;
  return row ?? null;
}

/** 同知识点或同错因复发次数（不含本题的其它未归档题目） */
export function recurrenceCount(itemId: string): number {
  const db = getDb();
  const item = getItem(itemId);
  if (!item) return 0;
  const tags = JSON.parse(item.knowledge_tags) as string[];
  const diag = getDiagnosis(itemId);

  let n = 0;
  if (tags.length > 0) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM error_item
         WHERE student_id = ? AND id != ? AND status != 'archived_not_worth_review'
           AND EXISTS (SELECT 1 FROM json_each(error_item.knowledge_tags) je WHERE je.value IN (SELECT value FROM json_each(?)))`,
      )
      .get(item.student_id, itemId, item.knowledge_tags) as { n: number };
    n = row.n;
  }
  if (diag) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM error_diagnosis d
         JOIN error_item ei ON ei.id = d.item_id
         WHERE ei.student_id = ? AND d.item_id != ? AND d.cause = ?
           AND ei.status != 'archived_not_worth_review'`,
      )
      .get(item.student_id, itemId, diag.cause) as { n: number };
    n = Math.max(n, row.n);
  }
  return n;
}

export function archiveItem(itemId: string): { ok: boolean; reason: string } {
  const db = getDb();
  const item = getItem(itemId);
  if (!item) return { ok: false, reason: '题目不存在' };
  const diag = getDiagnosis(itemId);
  const check = canArchive({
    reviewValue: (diag?.review_value as '必须再做' | '可以再做' | '没必要再做' | undefined) ?? null,
    recurrenceCount: recurrenceCount(itemId),
    masteryFeeling: (diag?.mastery_feeling as 0 | 1 | 2 | 3 | undefined) ?? null,
  });
  if (!check.ok) return { ok: false, reason: check.reason };
  db.prepare("UPDATE error_item SET status = 'archived_not_worth_review', archived_reason = ?, updated_at = ? WHERE id = ?")
    .run(check.reason, now(), itemId);
  return { ok: true, reason: check.reason };
}
