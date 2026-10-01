/**
 * v2.0 T4e：修改识别结果（"不对，改一下"）与修改记录（修正即测量）。
 * 只改转写保真与分类：题干、观察记录转写文字、学科、知识点；不碰坐标/区域/题号。
 * AI 只提"改前/改后"建议，学生点"接受"才生效；键盘直改不调用模型。
 * 规则 3 由校验层强制：不许把学生原作的错误"改对"（改动字符数 ≤ 原文 50% 且 ≤ 20）。
 * 只对 v2 来源的题服务；不走 Web 的 saveEvidence。instruction 与修改文字只存库、不进日志。
 */
import { getCorrectionProvider } from '../ai/index.js';
import { validateCorrectionChanges, validateEvidence, type CorrectionChange, type CorrectionProposalResult, type Evidence } from '../ai/evidence.js';
import type { CorrectionProvider } from '../ai/provider.js';
import { getDb, newId, now } from '../db/connection.js';
import { isoWeekKey } from '../domain/scheduling.js';
import type { Subject } from '../domain/types.js';
import { audit } from '../services/eventLog.js';
import { getEvidence } from '../services/evidenceService.js';
import { getItem } from '../services/itemService.js';
import { isV2Item, type V2WeekItem } from './weekService.js';

/** 每题每小时最多 6 次"生成修改建议"（规则 4）。 */
export const PROPOSE_RATE_LIMIT = 6;
const PROPOSE_RATE_WINDOW_MS = 60 * 60 * 1000;
/** 建议 10 分钟内有效。 */
export const PROPOSAL_TTL_MS = 10 * 60 * 1000;
const INSTRUCTION_MAX_CHARS = 200;
const PROPOSE_FAILURE_MESSAGE = '这次没生成出可用的修改，请换个说法或用键盘直接改';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface EvidenceView {
  questionText: string; subject: string; knowledgeTags: string[];
  observations: Array<{ id: string; kind: string; text: string }>;
  badge: 'ok' | 'low'; revision: number;
}

export type ProposeResult =
  | { ok: true; proposalId: string; revision: number; changes: CorrectionChange[]; clarify: string | null }
  | { ok: false; httpStatus: 400 | 404 | 409 | 429 | 502; message: string; revision?: number };

export type ApplyResult =
  | { ok: true; revision: number; card: V2WeekItem }
  | { ok: false; httpStatus: 400 | 404 | 409; message: string; revision?: number };

interface ProposalRow {
  id: string; item_id: string; base_revision: number; client_request_id: string;
  method: string; changes_json: string; clarify: string | null; created_at: string; accepted_at: string | null;
  error: string | null;
}

function notV2(itemId: string): boolean {
  return !getItem(itemId) || !isV2Item(itemId);
}

/** 学生可见的证据视图（供展示与键盘直改）。 */
export function getEvidenceView(itemId: string): EvidenceView | null {
  if (notV2(itemId)) return null;
  const record = getEvidence(itemId);
  if (!record) return null;
  const row = getDb().prepare('SELECT confidence_badge FROM evidence_record WHERE item_id = ?').get(itemId) as { confidence_badge: string | null };
  return {
    questionText: record.content.questionText,
    subject: record.content.subject,
    knowledgeTags: record.content.knowledgeTags,
    observations: record.content.observations.map(o => ({ id: o.id, kind: o.kind, text: o.text })),
    badge: row.confidence_badge === 'low' ? 'low' : 'ok',
    revision: record.revision,
  };
}

/**
 * 生成修改建议：每次调用 1 次模型；每题每小时最多 6 次实际模型调用（成功、校验失败、模型报错都计入）。
 * 幂等：同一 clientRequestId 重放返回同一结果（含失败的 502）、不再调用模型、不占限流额度。
 * 校验失败不重试，返回 502 级错误信息；失败也落一条 error 记录（不可被接受）。
 */
export async function proposeCorrection(itemId: string, body: unknown, provider?: CorrectionProvider): Promise<ProposeResult> {
  if (notV2(itemId)) return { ok: false, httpStatus: 404, message: '题目不存在或不属于手机上传。' };
  const input = (body ?? {}) as Record<string, unknown>;
  const instruction = typeof input.instruction === 'string' ? input.instruction.trim() : '';
  if (!instruction || instruction.length > INSTRUCTION_MAX_CHARS) return { ok: false, httpStatus: 400, message: '修改指令需要 1–200 字。' };
  if (input.method !== 'voice' && input.method !== 'keyboard') return { ok: false, httpStatus: 400, message: '修改方式不合法。' };
  const revision = input.revision;
  if (!Number.isInteger(revision) || (revision as number) < 1) return { ok: false, httpStatus: 400, message: 'revision 不合法。' };
  const clientRequestId = typeof input.clientRequestId === 'string' ? input.clientRequestId : '';
  if (!UUID.test(clientRequestId)) return { ok: false, httpStatus: 400, message: 'clientRequestId 须为 UUID。' };

  const db = getDb();
  // 幂等重放：返回同一结果（失败的也重放同一 502），不再调用模型。
  const existing = db.prepare('SELECT * FROM correction_proposal WHERE client_request_id = ?').get(clientRequestId) as ProposalRow | undefined;
  if (existing) {
    if (existing.item_id !== itemId) return { ok: false, httpStatus: 409, message: '请求标识已被使用。' };
    if (existing.error) return { ok: false, httpStatus: 502, message: PROPOSE_FAILURE_MESSAGE };
    return {
      ok: true, proposalId: existing.id, revision: existing.base_revision,
      changes: JSON.parse(existing.changes_json) as CorrectionChange[], clarify: existing.clarify,
    };
  }

  const record = getEvidence(itemId);
  if (!record) return { ok: false, httpStatus: 404, message: '没有可修改的识别结果。' };
  if (record.revision !== revision) return { ok: false, httpStatus: 409, message: '识别结果已更新，请重新加载。', revision: record.revision };

  // 规则 4：每题每小时最多 6 次实际模型调用（成功与失败都计入；重放不调用模型、不计数）。
  const cutoff = new Date(Date.now() - PROPOSE_RATE_WINDOW_MS).toISOString();
  const recent = db.prepare('SELECT COUNT(*) AS n FROM correction_proposal WHERE item_id = ? AND created_at > ?').get(itemId, cutoff) as { n: number };
  if (recent.n >= PROPOSE_RATE_LIMIT) return { ok: false, httpStatus: 429, message: '这题改得太频繁了，请一小时后再试，或用键盘直接改。' };

  let proposal: CorrectionProposalResult | null = null;
  try {
    proposal = await (provider ?? getCorrectionProvider()).proposeCorrection(record.content, instruction);
  } catch {
    // 模型/校验失败：不重试。
    proposal = null;
  }
  const notes = proposal?.rejected.map(r => r.reason) ?? [];
  const clarify = [proposal?.clarify, ...notes].filter(Boolean).join('；') || null;
  const changes = proposal?.changes ?? [];
  if (!proposal || (changes.length === 0 && !clarify)) {
    // 失败的模型调用也落一条 error 记录：计入限流，不可被接受；重放返回同一 502。
    db.prepare(
      `INSERT INTO correction_proposal (id, item_id, base_revision, client_request_id, instruction, method, changes_json, clarify, created_at, error)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(newId('crp'), itemId, record.revision, clientRequestId, instruction, input.method, '[]', null, now(), 'generate_failed');
    audit('v2_correction_failed', 'item', itemId);
    return { ok: false, httpStatus: 502, message: PROPOSE_FAILURE_MESSAGE };
  }

  const id = newId('crp');
  db.prepare(
    `INSERT INTO correction_proposal (id, item_id, base_revision, client_request_id, instruction, method, changes_json, clarify, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id, itemId, record.revision, clientRequestId, instruction, input.method, JSON.stringify(changes), clarify, now());
  audit('v2_correction_proposed', 'item', itemId);
  return { ok: true, proposalId: id, revision: record.revision, changes, clarify };
}

/** 卡片形状与 /v2/week 一致。 */
function cardOf(itemId: string): V2WeekItem {
  const row = getDb().prepare(
    `SELECT ei.id, ei.short_id, ei.subject, ei.knowledge_tags, ei.text_excerpt, ei.status, er.confidence_badge, mil.job_id
     FROM error_item ei
     JOIN mobile_item_link mil ON mil.item_id = ei.id
     LEFT JOIN evidence_record er ON er.item_id = ei.id
     WHERE ei.id = ?`,
  ).get(itemId) as { id: string; short_id: string | null; subject: string | null; knowledge_tags: string; text_excerpt: string | null; status: V2WeekItem['status']; confidence_badge: string | null; job_id: string };
  return {
    id: row.id, shortId: row.short_id, subject: row.subject,
    knowledgeTags: JSON.parse(row.knowledge_tags) as string[], questionExcerpt: row.text_excerpt,
    badge: row.confidence_badge === 'low' ? 'low' : 'ok', status: row.status,
    cropUrl: `/v2/items/${row.id}/crop`, jobId: row.job_id,
  };
}

function applyChanges(content: Evidence, changes: CorrectionChange[]): Evidence {
  const next: Evidence = { ...content, knowledgeTags: [...content.knowledgeTags], observations: content.observations.map(o => ({ ...o })) };
  for (const change of changes) {
    if (change.field === 'questionText') next.questionText = change.after;
    else if (change.field === 'subject') next.subject = change.after as Subject;
    else if (change.field === 'knowledgeTags') next.knowledgeTags = JSON.parse(change.after) as string[];
    else next.observations.find(o => o.id === change.observationId)!.text = change.after;
  }
  return validateEvidence(next);
}

/**
 * 在一个事务里应用修改：证据 content_json（过 validateEvidence）、revision+1、
 * 清空 diagnosis/coaching；仅当本次修改包含 questionText 时才把徽标设为 ok 并置空 auto_checks
 * （学生亲自核对过题干才视为可信；只改标签不代表题干被核对过）；
 * 同步 error_item 摘要；不改题目状态；逐条写 correction 记录。
 */
function applyCorrections(itemId: string, expectedRevision: number, changes: CorrectionChange[], method: 'voice' | 'keyboard' | 'direct', proposalId: string | null): ApplyResult {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const record = getEvidence(itemId)!;
    if (record.revision !== expectedRevision) {
      db.exec('ROLLBACK');
      return { ok: false, httpStatus: 409, message: '识别结果已更新，请重新加载。', revision: record.revision };
    }
    // 生效前按当前证据再校验一次（防御）。
    const check = validateCorrectionChanges(changes, record.content);
    if (check.rejected.length > 0) {
      db.exec('ROLLBACK');
      return { ok: false, httpStatus: 409, message: check.rejected.map(r => r.reason).join('；'), revision: record.revision };
    }
    const next = applyChanges(record.content, check.changes);
    const newRevision = record.revision + 1;
    const touchesQuestion = check.changes.some(c => c.field === 'questionText');
    if (touchesQuestion) {
      db.prepare(
        "UPDATE evidence_record SET content_json = ?, revision = ?, diagnosis_json = NULL, coaching_json = NULL, auto_checks_json = NULL, confidence_badge = 'ok', updated_at = ? WHERE item_id = ?",
      ).run(JSON.stringify(next), newRevision, now(), itemId);
    } else {
      db.prepare(
        'UPDATE evidence_record SET content_json = ?, revision = ?, diagnosis_json = NULL, coaching_json = NULL, updated_at = ? WHERE item_id = ?',
      ).run(JSON.stringify(next), newRevision, now(), itemId);
    }
    db.prepare('UPDATE error_item SET text_excerpt = ?, subject = ?, knowledge_tags = ?, updated_at = ? WHERE id = ?')
      .run(next.questionText.slice(0, 80), next.subject, JSON.stringify(next.knowledgeTags), now(), itemId);
    for (const change of check.changes) {
      const field = change.field === 'observation'
        ? record.content.observations.find(o => o.id === change.observationId)!.kind
        : change.field;
      db.prepare(
        'INSERT INTO correction (id, item_id, field, observation_id, before_text, after_text, method, proposal_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      ).run(newId('cor'), itemId, field, change.observationId ?? null, change.before, change.after, method, proposalId, now());
    }
    if (proposalId) db.prepare('UPDATE correction_proposal SET accepted_at = ? WHERE id = ?').run(now(), proposalId);
    db.exec('COMMIT');
    return { ok: true, revision: newRevision, card: cardOf(itemId) };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/** 接受建议：建议须未过期（10 分钟）、未被接受过、revision 仍是当前值。 */
export function acceptCorrection(itemId: string, body: unknown): ApplyResult {
  if (notV2(itemId)) return { ok: false, httpStatus: 404, message: '题目不存在或不属于手机上传。' };
  const input = (body ?? {}) as Record<string, unknown>;
  const proposalId = typeof input.proposalId === 'string' ? input.proposalId : '';
  if (!proposalId) return { ok: false, httpStatus: 400, message: '缺少 proposalId。' };
  const revision = input.revision;
  if (!Number.isInteger(revision) || (revision as number) < 1) return { ok: false, httpStatus: 400, message: 'revision 不合法。' };

  const db = getDb();
  const proposal = db.prepare('SELECT * FROM correction_proposal WHERE id = ?').get(proposalId) as ProposalRow | undefined;
  if (!proposal || proposal.item_id !== itemId) return { ok: false, httpStatus: 404, message: '修改建议不存在。' };
  if (proposal.error) return { ok: false, httpStatus: 409, message: '该建议未成功生成，无法接受。' };
  if (proposal.accepted_at) return { ok: false, httpStatus: 409, message: '该建议已被接受。' };
  if (Date.now() - new Date(proposal.created_at).getTime() > PROPOSAL_TTL_MS) return { ok: false, httpStatus: 409, message: '该建议已过期，请重新生成。' };
  const record = getEvidence(itemId);
  if (!record) return { ok: false, httpStatus: 404, message: '没有可修改的识别结果。' };
  if (record.revision !== revision || proposal.base_revision !== revision) {
    return { ok: false, httpStatus: 409, message: '识别结果已更新，该建议已失效。', revision: record.revision };
  }
  const changes = JSON.parse(proposal.changes_json) as CorrectionChange[];
  if (changes.length === 0) return { ok: false, httpStatus: 409, message: '该建议没有可接受的修改。' };

  const result = applyCorrections(itemId, record.revision, changes, proposal.method as 'voice' | 'keyboard', proposal.id);
  if (result.ok) audit('v2_correction_accepted', 'item', itemId);
  return result;
}

/** 键盘直改：不调用模型，同样的校验（before 必须匹配当前值），直接生效，记 method=direct。 */
export function directCorrection(itemId: string, body: unknown): ApplyResult {
  if (notV2(itemId)) return { ok: false, httpStatus: 404, message: '题目不存在或不属于手机上传。' };
  const input = (body ?? {}) as Record<string, unknown>;
  const revision = input.revision;
  if (!Number.isInteger(revision) || (revision as number) < 1) return { ok: false, httpStatus: 400, message: 'revision 不合法。' };
  const record = getEvidence(itemId);
  if (!record) return { ok: false, httpStatus: 404, message: '没有可修改的识别结果。' };
  if (record.revision !== revision) return { ok: false, httpStatus: 409, message: '识别结果已更新，请重新加载。', revision: record.revision };

  let check: ReturnType<typeof validateCorrectionChanges>;
  try {
    check = validateCorrectionChanges(input.changes, record.content);
  } catch (error) {
    return { ok: false, httpStatus: 400, message: `修改内容不合法：${error instanceof Error ? error.message : String(error)}` };
  }
  if (check.rejected.length > 0) return { ok: false, httpStatus: 400, message: check.rejected.map(r => r.reason).join('；') };
  if (check.changes.length === 0) return { ok: false, httpStatus: 400, message: '没有可生效的修改。' };

  const result = applyCorrections(itemId, record.revision, check.changes, 'direct', null);
  if (result.ok) audit('v2_correction_direct', 'item', itemId);
  return result;
}

// ---------- 修正即测量报告 ----------

const REPORT_FIELDS = ['questionText', 'student_work', 'correction', 'teacher_note', 'reference_answer', 'subject', 'knowledgeTags'] as const;

export interface CorrectionFieldStat { field: string; corrected: number; total: number; rate: number }
export interface CorrectionWeekReport { week: string; itemCount: number; fields: CorrectionFieldStat[]; notAMistake: { count: number; rate: number } }

/** 该题当前证据是否"含该字段"（标量字段恒有；knowledgeTags 需非空；观察记录需存在该类型）。 */
function evidenceHasField(contentJson: string | null, field: string): boolean {
  if (!contentJson) return false;
  try {
    const e = JSON.parse(contentJson) as Partial<Evidence>;
    if (field === 'questionText') return typeof e.questionText === 'string' && e.questionText.trim().length > 0;
    if (field === 'subject') return typeof e.subject === 'string' && e.subject.length > 0;
    if (field === 'knowledgeTags') return Array.isArray(e.knowledgeTags) && e.knowledgeTags.length > 0;
    return Array.isArray(e.observations) && e.observations.some(o => o.kind === field);
  } catch {
    return false;
  }
}

/**
 * 修正即测量：按周（登记的 ISO 周）按字段给出 corrected/total/rate，
 * 以及"不是错题"的数量与占比。只输出计数，不返回任何题目文字。
 */
export function getCorrectionsReport(): { weeks: CorrectionWeekReport[] } {
  const db = getDb();
  const items = db.prepare(
    `SELECT ei.id, vp.registered_at, ei.archived_reason, er.content_json
     FROM mobile_item_link mil
     JOIN error_item ei ON ei.id = mil.item_id
     JOIN v2_photo vp ON vp.job_id = mil.job_id
     LEFT JOIN evidence_record er ON er.item_id = ei.id`,
  ).all() as Array<{ id: string; registered_at: string; archived_reason: string | null; content_json: string | null }>;
  const corrections = db.prepare('SELECT item_id, field FROM correction').all() as Array<{ item_id: string; field: string }>;

  const weekOfItem = new Map<string, string>();
  const weeks = new Map<string, typeof items>();
  for (const item of items) {
    const week = isoWeekKey(new Date(item.registered_at));
    weekOfItem.set(item.id, week);
    const bucket = weeks.get(week) ?? [];
    bucket.push(item);
    weeks.set(week, bucket);
  }
  // week -> field -> 被修改过的题（去重）
  const corrected = new Map<string, Map<string, Set<string>>>();
  for (const c of corrections) {
    const week = weekOfItem.get(c.item_id);
    if (!week) continue;
    if (!corrected.has(week)) corrected.set(week, new Map());
    const byField = corrected.get(week)!;
    if (!byField.has(c.field)) byField.set(c.field, new Set());
    byField.get(c.field)!.add(c.item_id);
  }

  const report: CorrectionWeekReport[] = [];
  for (const [week, bucket] of [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const byField = corrected.get(week);
    const fields: CorrectionFieldStat[] = REPORT_FIELDS.map(field => {
      const total = bucket.filter(item => evidenceHasField(item.content_json, field)).length;
      const correctedCount = byField?.get(field)?.size ?? 0;
      return { field, corrected: correctedCount, total, rate: total === 0 ? 0 : correctedCount / total };
    });
    const notAMistakeCount = bucket.filter(item => item.archived_reason === 'not_a_mistake').length;
    report.push({
      week, itemCount: bucket.length, fields,
      notAMistake: { count: notAMistakeCount, rate: bucket.length === 0 ? 0 : notAMistakeCount / bucket.length },
    });
  }
  return { weeks: report };
}
