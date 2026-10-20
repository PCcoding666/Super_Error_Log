import { getDb, newId, now } from '../db/connection.js';
import { isoWeekKey, plannedDateForPacket, PLAN_MAX, PLAN_MIN, selectWeeklyPlan, type PlanCandidate } from '../domain/scheduling.js';
import { bridgePending } from '../bridge/recognitionToItems.js';
import { audit } from '../services/eventLog.js';
import { ensureStudentProfile } from '../services/studentService.js';
import { getV2Settings } from '../v2/settingsService.js';
import type { ItemStatus } from '../domain/types.js';
import type { PracticeSummary } from '../v2/practiceService.js';
import type { LearningScope, LearningWeek, LearningPracticeCard, LearningRecommendation, LearningPracticeDetail, LearningCreateResult } from './contracts.js';
import { getLearningSource, learningEligible, learningIncluded, learningPacketAllowed, learningCard } from './sources.js';
import { getLegacyWeek } from '../v2/weekService.js';

export function getLearningWeek(mobileDataDir:string, scope:LearningScope='all'):LearningWeek {
 const old=getLegacyWeek(mobileDataDir);
 const convert=(card:typeof old.items[number])=>{const {jobId,...rest}=card;return {...rest,source:{kind:'legacy' as const,jobId}};};
 const result:LearningWeek={...old,items:old.items.filter(c=>getLearningSource(c.id)?.kind==='legacy'&&learningIncluded(c.id)).map(convert),backlog:old.backlog.filter(c=>getLearningSource(c.id)?.kind==='legacy'&&learningIncluded(c.id)).map(convert)};
 if(scope==='legacy')return result;
 const rows=getDb().prepare('SELECT item_id,created_at FROM material_item_link ORDER BY created_at,item_id').all() as {item_id:string;created_at:string}[];
 for(const row of rows){
  if(getLearningSource(row.item_id)?.kind!=='material'||!learningIncluded(row.item_id))continue;
  const card=learningCard(row.item_id)!;
  if(isoWeekKey(new Date(row.created_at))===result.week)result.items.push(card);
  else if(['ready_for_reflection','eligible_for_review','needs_recheck'].includes(card.status))result.backlog.push(card);
 }
 return result;
}
type CandidateRow = {
  id: string; short_id: string | null; subject: string | null; knowledge_tags: string;
  text_excerpt: string | null; status: ItemStatus; item_index: number; created_at: string;
  job_id: string; confidence_badge: string | null; reflected: number;
};

/** 候选：v2 来源、候选状态、未归档、不在"未回传的练习包"里（与 discardV2Item 同一判定）。 */
function candidateRows(scope: LearningScope): CandidateRow[] {
  return (getDb().prepare(
    `SELECT ei.id, ei.short_id, ei.subject, ei.knowledge_tags, ei.text_excerpt, ei.status, ei.item_index, ei.created_at,
            mil.job_id, er.confidence_badge,
            EXISTS(SELECT 1 FROM error_diagnosis d WHERE d.item_id = ei.id) AS reflected
     FROM error_item ei
     LEFT JOIN mobile_item_link mil ON mil.item_id = ei.id
     LEFT JOIN evidence_record er ON er.item_id = ei.id
     WHERE (
       ei.status IN ('needs_recheck', 'attempted', 'ready_for_reflection', 'eligible_for_review')
       OR (ei.status = 'temporarily_mastered' AND ei.next_review_at IS NOT NULL AND ei.next_review_at <= ?)
     )
     AND NOT EXISTS (
       SELECT 1 FROM review_packet_item rpi
       WHERE rpi.item_id = ei.id
         AND NOT EXISTS (SELECT 1 FROM review_attempt ra WHERE ra.packet_id = rpi.packet_id AND ra.item_id = rpi.item_id)
     )`,
  ).all(now()) as CandidateRow[]).filter(row => { const source=getLearningSource(row.id); return source && (scope==='all'||source.kind==='legacy') && learningEligible(row.id); });
}

/** 复发数：近 28 天内与该题共享任一知识点的 v2 题数（含自身，不含已归档）。 */
function recurrenceCount28d(row: CandidateRow, scope:LearningScope): number {
  const tags = JSON.parse(row.knowledge_tags) as string[];
  if (tags.length === 0) return 0;
  const cutoff = new Date(Date.now() - 28 * 86400000).toISOString();
  const rows=getDb().prepare(
    `SELECT ei.id FROM error_item ei WHERE ei.created_at >= ? AND ei.status != 'archived_not_worth_review'
       AND EXISTS (SELECT 1 FROM json_each(ei.knowledge_tags) je WHERE je.value IN (SELECT value FROM json_each(?)))`,
  ).all(cutoff,row.knowledge_tags) as {id:string}[];
  return rows.filter(r=>{const source=getLearningSource(r.id);return source&&(scope==='all'||source.kind==='legacy')&&learningIncluded(r.id);}).length;
}

const TIER_BASE = { 1: 300, 2: 200, 3: 150, 4: 100 } as const;

function tierOf(row: CandidateRow): 1 | 2 | 3 | 4 {
  if (row.status === 'needs_recheck') return 1;
  if (row.status === 'temporarily_mastered') return 2;
  if (row.status === 'attempted') return 3;
  return 4;
}

function reasonOf(tier: 1 | 2 | 3 | 4, primaryTag: string | null, recurrence: number): string {
  if (tier === 1) return '上次练习没独立做对';
  if (tier === 2) return '上次做对了，到了再确认一次的时候';
  if (tier === 3) return '上次是当场做对，还要隔几天再验证';
  return recurrence >= 2 ? `「${primaryTag}」近四周错了 ${recurrence} 次` : '本周新错题';
}

interface ScoredCandidate { row: CandidateRow; card: LearningPracticeCard; score: number; order: number }

/** 候选打分：分层基础分 + 复发分（复发数×10，上限 50）；同分按登记早优先、再按 item_index。 */
function scoreCandidates(scope:LearningScope): ScoredCandidate[] {
  const scored = candidateRows(scope).map((row): Omit<ScoredCandidate, 'order'> => {
    const tags = JSON.parse(row.knowledge_tags) as string[];
    const primaryTag = tags[0] ?? null;
    const recurrence = recurrenceCount28d(row,scope);
    const tier = tierOf(row);
    const score = TIER_BASE[tier] + Math.min(recurrence * 10, 50);
    return {
      row,
      score,
      card: {
        id: row.id,
        shortId: row.short_id,
        subject: row.subject,
        knowledgeTags: tags,
        questionExcerpt: row.text_excerpt,
        badge: learningCard(row.id)!.badge,
        status: row.status,
        cropUrl: learningCard(row.id)!.cropUrl,
        source: getLearningSource(row.id)!,
        reason: reasonOf(tier, primaryTag, recurrence),
        tier,
        reflected: row.reflected === 1,
      },
    };
  });
  scored.sort((a, b) =>
    b.score - a.score
    || a.row.created_at.localeCompare(b.row.created_at)
    || a.row.item_index - b.row.item_index
    || a.row.id.localeCompare(b.row.id));
  return scored.map((entry, index) => ({ ...entry, order: index }));
}

/** 本周推荐：先懒桥接，再分层打分，selectWeeklyPlan 负责 5–8 与同知识点上限。 */
export function recommendLearningPractice(mobileDataDir: string, scope:LearningScope='all'): LearningRecommendation {
  try {
    bridgePending(mobileDataDir);
  } catch {
    // 懒桥接整体失败不影响返回。
  }
  const scored = scoreCandidates(scope);
  const candidates: PlanCandidate[] = scored.map(entry => ({
    itemId: entry.row.id,
    score: entry.score,
    primaryTag: entry.card.knowledgeTags[0] ?? null,
    conflict: false,
    order: entry.order,
  }));
  const plan = selectWeeklyPlan(candidates);
  const selected = new Set(plan.selected);
  return {
    recommended: scored.filter(entry => selected.has(entry.row.id)).map(entry => entry.card),
    others: scored.filter(entry => !selected.has(entry.row.id)).map(entry => entry.card),
    notes: plan.notes,
    limits: { min: PLAN_MIN, max: PLAN_MAX },
  };
}

/** 建练习：1–8 道、不重复、全部在当前候选集内；复盘不是前提。暂时掌握题保持原状态（D7）。 */
export function createLearningPractice(input: unknown, scope:LearningScope='all'): LearningCreateResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, httpStatus: 400, message: '请求正文不合法。' };
  }
  const body = input as Record<string, unknown>;
  const itemIds = body.itemIds;
  if (!Array.isArray(itemIds) || itemIds.length === 0 || itemIds.some(id => typeof id !== 'string' || id.length === 0)) {
    return { ok: false, httpStatus: 400, message: 'itemIds 必须是非空的题目 ID 数组。' };
  }
  const ids = itemIds as string[];
  if (new Set(ids).size !== ids.length) {
    return { ok: false, httpStatus: 400, message: '题目不能重复。' };
  }
  if (ids.length > PLAN_MAX) {
    return { ok: false, httpStatus: 400, message: `一次练习最多 ${PLAN_MAX} 道。` };
  }
  let practiceSlot: string;
  if (body.practiceSlot === undefined) {
    practiceSlot = getV2Settings().practiceSlot;
  } else if (typeof body.practiceSlot === 'string' && body.practiceSlot.length >= 1 && body.practiceSlot.length <= 20) {
    practiceSlot = body.practiceSlot;
  } else {
    return { ok: false, httpStatus: 400, message: 'practiceSlot 必须是 1–20 字的字符串。' };
  }

  const eligible = new Map(scoreCandidates(scope).map(entry => [entry.row.id, entry]));
  const invalid = ids.filter(id => !eligible.has(id));
  if (invalid.length > 0) {
    return { ok: false, httpStatus: 409, message: `以下题目当前不可安排：${invalid.join('、')}` };
  }

  const db = getDb();
  const student = ensureStudentProfile();
  const nowDate = new Date();
  const packetId = newId('pkt');
  // 整个建包写入放一个事务：中途任何一步失败整体回滚，不留半份练习包。
  try {
    db.exec('BEGIN');
    db.prepare(
      'INSERT INTO review_packet (id, student_id, week, status, planned_date, practice_slot, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(packetId, student.id, isoWeekKey(nowDate), 'scheduled', plannedDateForPacket(nowDate), practiceSlot, now());
    ids.forEach((itemId, index) => {
      const entry = eligible.get(itemId)!;
      // hint/answer 占位，T5 负责生成；v2_tier/v2_reason 冻结建包时的推荐层级与理由。
      db.prepare('INSERT INTO review_packet_item (packet_id, item_id, position, hint_text, answer_text, v2_tier, v2_reason) VALUES (?,?,?,?,?,?,?)')
        .run(packetId, itemId, index, '待生成', '待生成', entry.card.tier, entry.card.reason);
      // 确认轮题目保持 temporarily_mastered，回传时据此判定确认作答（D7）。
      db.prepare("UPDATE error_item SET status = 'scheduled', updated_at = ? WHERE id = ? AND status != 'temporarily_mastered'")
        .run(now(), itemId);
    });
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  audit('v2_practice_created', 'packet', packetId);
  const detail = getLearningPractice(packetId,scope);
  if (!detail) throw new Error('练习创建后读取失败');
  return { ok: true, detail };
}

/** 练习详情：仅限含 v2 题的练习包，否则 null（路由层 404）。 */
export function getLearningPractice(packetId: string, scope:LearningScope='all'): LearningPracticeDetail | null {
  const db = getDb();
  const packet = db.prepare('SELECT * FROM review_packet WHERE id = ?').get(packetId) as
    { id: string; week: string; status: string; practice_slot: string | null; created_at: string; generated_at: string | null } | undefined;
  if (!packet) return null;
  if (!learningPacketAllowed(packetId,scope)) return null;

  type ItemRow = CandidateRow & { position: number; v2_tier: number | null; v2_reason: string | null };
  const rows = db.prepare(
    `SELECT ei.id, ei.short_id, ei.subject, ei.knowledge_tags, ei.text_excerpt, ei.status, ei.item_index, ei.created_at,
            mil.job_id, er.confidence_badge, rpi.position, rpi.v2_tier, rpi.v2_reason,
            EXISTS(SELECT 1 FROM error_diagnosis d WHERE d.item_id = ei.id) AS reflected
     FROM review_packet_item rpi
     JOIN error_item ei ON ei.id = rpi.item_id
     LEFT JOIN mobile_item_link mil ON mil.item_id = ei.id
     LEFT JOIN evidence_record er ON er.item_id = ei.id
     WHERE rpi.packet_id = ?
     ORDER BY rpi.position`,
  ).all(packetId) as ItemRow[];

  const tierLabel: Record<ItemStatus, 1 | 2 | 3 | 4> = {
    needs_recheck: 1, temporarily_mastered: 2, attempted: 3,
    ready_for_reflection: 4, eligible_for_review: 4,
    captured: 4, needs_review: 4, scheduled: 4, packet_generated: 4,
    stably_mastered: 4, archived_not_worth_review: 4,
  };
  return {
    id: packet.id,
    week: packet.week,
    status: packet.status,
    practiceSlot: packet.practice_slot,
    createdAt: packet.created_at,
    generatedAt: packet.generated_at,
    items: rows.map(row => {
      const tags = JSON.parse(row.knowledge_tags) as string[];
      // 建包时冻结的层级与理由优先；旧包（无此列值）退回按当前状态重算。
      const tier = (row.v2_tier as 1 | 2 | 3 | 4 | null) ?? tierLabel[row.status];
      const reason = row.v2_reason ?? reasonOf(tier, tags[0] ?? null, recurrenceCount28d(row,scope));
      return {
        id: row.id,
        shortId: row.short_id,
        subject: row.subject,
        knowledgeTags: tags,
        questionExcerpt: row.text_excerpt,
        badge: learningCard(row.id)!.badge,
        status: row.status,
        cropUrl: learningCard(row.id)!.cropUrl,
        source: getLearningSource(row.id)!,
        reason,
        tier,
        reflected: row.reflected === 1,
        position: row.position,
      };
    }),
  };
}

/** 最近 8 个含 v2 题的练习包摘要，新的在前。 */
export function listLearningPractices(scope:LearningScope='all'): PracticeSummary[] {
  const rows = getDb().prepare(
    `SELECT rp.id, rp.week, rp.status, rp.practice_slot, rp.created_at, rp.generated_at,
            (SELECT COUNT(*) FROM review_packet_item rpi WHERE rpi.packet_id = rp.id) AS item_count
     FROM review_packet rp
     ORDER BY rp.created_at DESC, rp.rowid DESC
`,
  ).all() as Array<{ id: string; week: string; status: string; practice_slot: string | null; created_at: string; generated_at: string | null; item_count: number }>;
  return rows.filter(row=>learningPacketAllowed(row.id,scope)).slice(0,8).map(row => ({
    id: row.id,
    week: row.week,
    status: row.status,
    practiceSlot: row.practice_slot,
    createdAt: row.created_at,
    generatedAt: row.generated_at,
    itemCount: row.item_count,
  }));
}
