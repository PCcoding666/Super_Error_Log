import { getDb, now } from '../db/connection.js';
import { audit } from '../services/eventLog.js';
import { createLearningPractice, getLearningPractice, learningRedoOverview, recommendLearningPractice, type LearningRedoOverview } from '../learning/queries.js';
import type { LearningCreateResult, LearningPracticeCard, LearningPracticeDetail, LearningRecommendation } from '../learning/contracts.js';
import { cooldownUntil, todayText } from '../learning/redoSchedule.js';

export type TaskLifecycle = 'active' | 'paused' | 'cancelled';
export function taskLifecycle(packetId: string): TaskLifecycle {
  const row = getDb().prepare('SELECT lifecycle FROM practice_task WHERE packet_id=?').get(packetId) as {lifecycle:TaskLifecycle} | undefined;
  return row?.lifecycle ?? 'active';
}
export function assertTaskWritable(packetId: string): void {
  if (!getLearningPractice(packetId, 'all')) throw new Error('练习不存在');
  if (taskLifecycle(packetId) === 'cancelled') throw new Error('这份练习已取消，已记录的结果仍然保留。');
}
export function activePractice(): LearningPracticeDetail | null {
  const row = getDb().prepare(`
    SELECT rp.id FROM review_packet rp
    LEFT JOIN practice_task pt ON pt.packet_id=rp.id
    WHERE COALESCE(pt.lifecycle,'active')='active'
      AND EXISTS (SELECT 1 FROM review_packet_item rpi
        WHERE rpi.packet_id=rp.id
          AND (EXISTS (SELECT 1 FROM mobile_item_link mil WHERE mil.item_id=rpi.item_id)
            OR EXISTS (SELECT 1 FROM material_item_link ml WHERE ml.item_id=rpi.item_id))
          AND NOT EXISTS (SELECT 1 FROM review_attempt ra WHERE ra.packet_id=rp.id AND ra.item_id=rpi.item_id))
    ORDER BY rp.created_at, rp.rowid LIMIT 1`).get() as {id:string} | undefined;
  return row ? getLearningPractice(row.id, 'all') : null;
}
export const SUGGESTED_SIZE = 3;
export type SuggestedPractice = LearningRecommendation & {redo: LearningRedoOverview};
/**
 * 首页建议的一小组（3 道）。重练题分数高于新错题，为了让积压的新错题轮得到：
 * 只要候选里还有新错题（tier 4），这 3 道里至少放 1 道（P0-3）。冷却中的当场做对题已在推荐层排除。
 */
export function suggestedPractice(dir: string): SuggestedPractice {
  const all = recommendLearningPractice(dir, 'all');
  const today = todayText();
  const cooling = (card: LearningPracticeCard): boolean => card.status === 'attempted' && (cooldownUntil(card.id) ?? '') > today;
  const ranked = [...all.recommended, ...all.others.filter(card => !cooling(card))];
  const picked = all.recommended.slice(0, SUGGESTED_SIZE);
  if (picked.length === SUGGESTED_SIZE && !picked.some(card => card.tier === 4)) {
    const fresh = ranked.find(card => card.tier === 4 && !picked.includes(card));
    if (fresh) picked[SUGGESTED_SIZE - 1] = fresh;
  }
  const chosen = new Set(picked.map(card => card.id));
  const others = [...all.recommended, ...all.others].filter(card => !chosen.has(card.id));
  return {...all,recommended:picked,others,notes:[],limits:{min:1,max:8},redo:learningRedoOverview('all')};
}
export function startSuggestedPractice(dir: string, key: string): LearningCreateResult {
  if (!/^[0-9a-f-]{36}$/i.test(key)) return {ok:false,httpStatus:400,message:'请重新打开推荐后再试。'};
  const previous=getDb().prepare('SELECT packet_id FROM practice_task WHERE request_key=?').get(key) as {packet_id:string} | undefined;
  if (previous) {
    const detail=getLearningPractice(previous.packet_id, 'all');
    if (detail) return {ok:true,detail};
  }
  const current=activePractice();
  if (current) return {ok:true,detail:current};
  const ids=suggestedPractice(dir).recommended.map(item=>item.id);
  if (!ids.length) return {ok:false,httpStatus:409,message:'现在没有需要安排的题，可以查看错题本或录入新错题。'};
  return createLearningPractice({itemIds:ids,requestKey:key}, 'all');
}
export function setTaskLifecycle(packetId: string, lifecycle: TaskLifecycle): void {
  if (!['active','paused','cancelled'].includes(lifecycle)) throw new Error('练习状态无效');
  assertTaskWritable(packetId);
  const db=getDb();
  const original=db.prepare('SELECT original_statuses FROM practice_task WHERE packet_id=?').get(packetId) as {original_statuses:string} | undefined;
  const statuses=JSON.parse(original?.original_statuses ?? '{}') as Record<string,string>;
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO practice_task(packet_id,lifecycle,updated_at) VALUES (?,?,?)
      ON CONFLICT(packet_id) DO UPDATE SET lifecycle=excluded.lifecycle,updated_at=excluded.updated_at`).run(packetId,lifecycle,now());
    if (lifecycle==='cancelled') {
      // Reflection (error_diagnosis) is attached per question, not per round,
      // so a diagnosis from any earlier round still counts as already reflected.
      const unanswered=db.prepare(`SELECT rpi.item_id,rpi.v2_tier,
          EXISTS(SELECT 1 FROM error_diagnosis d WHERE d.item_id=rpi.item_id) AS reflected
        FROM review_packet_item rpi
        WHERE rpi.packet_id=? AND NOT EXISTS (SELECT 1 FROM review_attempt ra WHERE ra.packet_id=rpi.packet_id AND ra.item_id=rpi.item_id)`)
        .all(packetId) as Array<{item_id:string;v2_tier:number|null;reflected:number}>;
      for (const item of unanswered) {
        // Legacy tasks have no original status snapshot; tier 4 covers both
        // reflected and unreflected items, so recover that distinction from data.
        const fallback=item.v2_tier===1?'needs_recheck':item.v2_tier===2?'temporarily_mastered':item.v2_tier===3?'attempted'
          :item.reflected?'eligible_for_review':'ready_for_reflection';
        db.prepare(`UPDATE error_item SET status=?,updated_at=? WHERE id=? AND status IN ('scheduled','packet_generated')
          AND NOT EXISTS (SELECT 1 FROM review_packet_item other
            WHERE other.item_id=error_item.id AND other.packet_id<>?
              AND NOT EXISTS (SELECT 1 FROM practice_task pt WHERE pt.packet_id=other.packet_id AND pt.lifecycle='cancelled')
              AND NOT EXISTS (SELECT 1 FROM review_attempt ra WHERE ra.packet_id=other.packet_id AND ra.item_id=other.item_id))`)
          .run(statuses[item.item_id]??fallback,now(),item.item_id,packetId);
      }
    }
    db.exec('COMMIT');
  } catch(error) {db.exec('ROLLBACK');throw error;}
  audit(`practice_${lifecycle}`,'packet',packetId);
}
