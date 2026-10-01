/**
 * v2.0 T4d：回传与回报。
 * 掌握判定完全复用 Web 的 recordAttempt（不在此复制规则）；本模块只做：
 * 手机端五选项 → Web Completion 的入参映射、形状校验（形状错整体 400、规则错逐条 ok:false）、回报汇总。
 * 仅限 v2 练习包（含 mobile_item_link 的包）；写操作记 audit（只记 ID）。
 */
import { getDb } from '../db/connection.js';
import { recordAttempt, type AttemptInput } from '../services/attemptService.js';
import { audit } from '../services/eventLog.js';
import type { ItemStatus } from '../domain/types.js';
import type { V2WeekItem } from './weekService.js';

const V2_COMPLETIONS = ['independent', 'hint1', 'hint2', 'not_solved', 'not_done'] as const;
type V2Completion = (typeof V2_COMPLETIONS)[number];

const RETURN_MIN = 1;
const RETURN_MAX = 8;

export interface ReturnItemResult {
  itemId: string;
  ok: boolean;
  toStatus?: string;
  reason?: string;
  error?: string;
}

export type SubmitReturnResult =
  | { ok: true; results: ReturnItemResult[] }
  | { ok: false; httpStatus: 400 | 404; message: string };

/** 包存在且含 v2 题（与 getPractice 同一判定）。 */
function isV2Packet(packetId: string): boolean {
  const db = getDb();
  const packet = db.prepare('SELECT 1 AS x FROM review_packet WHERE id = ?').get(packetId);
  if (!packet) return false;
  return !!db.prepare(
    `SELECT 1 FROM review_packet_item rpi JOIN mobile_item_link mil ON mil.item_id = rpi.item_id WHERE rpi.packet_id = ? LIMIT 1`,
  ).get(packetId);
}

interface MappedEntry { itemId: string; input: AttemptInput }

/** 单条入参形状校验 + 映射。形状不合法整条请求 400（不调用 recordAttempt）。 */
function mapEntry(raw: unknown): { ok: true; entry: MappedEntry } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: '每条结果必须是对象。' };
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.itemId !== 'string' || body.itemId.length === 0) {
    return { ok: false, message: 'itemId 必须是非空字符串。' };
  }
  if (typeof body.completion !== 'string' || !V2_COMPLETIONS.includes(body.completion as V2Completion)) {
    return { ok: false, message: 'completion 必须是 independent/hint1/hint2/not_solved/not_done 之一。' };
  }
  if (typeof body.performedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.performedOn)) {
    return { ok: false, message: 'performedOn 必须是 YYYY-MM-DD 文本（纸上实际作答日期）。' };
  }
  if (body.stuckStep !== undefined && typeof body.stuckStep !== 'string') {
    return { ok: false, message: 'stuckStep 必须是文本。' };
  }
  const completion = body.completion as V2Completion;
  const needsCorrect = completion === 'independent' || completion === 'hint1' || completion === 'hint2';
  if (needsCorrect && typeof body.correct !== 'boolean') {
    return { ok: false, message: '独立做出或看了提示时，必须给出布尔值 correct。' };
  }
  if (!needsCorrect && body.correct !== undefined && body.correct !== false) {
    return { ok: false, message: '没做出来/没做的题，correct 只能缺省或为 false。' };
  }

  const mappedCompletion: AttemptInput['completion'] =
    completion === 'independent' ? 'independent'
      : needsCorrect ? 'hint_used'
        : completion === 'not_solved' ? 'failed' : 'unfinished';
  const input: AttemptInput = {
    completion: mappedCompletion,
    correct: needsCorrect ? (body.correct as boolean) : false,
    performedAt: body.performedOn,
    hintLevel: completion === 'hint1' ? 1 : completion === 'hint2' ? 2 : 0,
  };
  if (typeof body.stuckStep === 'string') input.stuckStep = body.stuckStep;
  return { ok: true, entry: { itemId: body.itemId, input } };
}

/**
 * 回传：形状校验（整体 400）后逐条独立调用 recordAttempt（某条被拒不影响其他条）。
 * 分批回传天然支持：每次 1–8 条，同一包同一题只回传一次由 recordAttempt 保证。
 */
export function submitReturns(packetId: string, input: unknown): SubmitReturnResult {
  if (!isV2Packet(packetId)) return { ok: false, httpStatus: 404, message: '练习不存在。' };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, httpStatus: 400, message: '请求正文不合法。' };
  }
  const results = (input as Record<string, unknown>).results;
  if (!Array.isArray(results) || results.length < RETURN_MIN || results.length > RETURN_MAX) {
    return { ok: false, httpStatus: 400, message: `results 必须是 ${RETURN_MIN}–${RETURN_MAX} 条的数组。` };
  }
  const mapped: MappedEntry[] = [];
  for (const raw of results) {
    const entry = mapEntry(raw);
    if (!entry.ok) return { ok: false, httpStatus: 400, message: entry.message };
    mapped.push(entry.entry);
  }
  const out = mapped.map(({ itemId, input: attempt }) => ({
    itemId,
    ...recordAttempt(packetId, itemId, attempt, 'student'),
  }));
  audit('v2_return_submitted', 'packet', packetId);
  return { ok: true, results: out };
}

export interface ReturnSummary {
  /** 已回传数 / 本包总题数。 */
  answered: number;
  total: number;
  /** 独立且做对的题数。 */
  independentCorrect: number;
  /** 本包回传后进入暂时/稳定掌握的题卡片（/v2/week 形状）；仅限本包已回传的题。 */
  masteredNow: V2WeekItem[];
  /** 状态为 needs_recheck 的题卡片，附"下次再来"原因。 */
  again: Array<V2WeekItem & { reason: string }>;
  /** 校准：本包已回传且最近一次复盘把握 ≥2 的题里，没独立做对的题数与卡片；基数为 0 时 text 为 null。 */
  calibration: { confidentTotal: number; missedCount: number; text: string | null; items: V2WeekItem[] };
  /** 本包新进入暂时掌握的题中最早的确认日期（YYYY-MM-DD，仅日期）；无则 null。 */
  nextConfirmOn: string | null;
}

type SummaryRow = {
  id: string; short_id: string | null; subject: string | null; knowledge_tags: string;
  text_excerpt: string | null; status: ItemStatus; next_review_at: string | null;
  job_id: string; confidence_badge: string | null;
  att_completion: string | null; att_correct: number | null;
};

const AGAIN_REASON: Record<string, string> = {
  hint_used: '看了提示',
  failed: '没做出来',
  unfinished: '没做',
  independent: '做错',
};

/** 回报：仅限 v2 练习包，否则 null（路由层 404）。 */
export function getReturnSummary(packetId: string): ReturnSummary | null {
  if (!isV2Packet(packetId)) return null;
  const db = getDb();
  const rows = db.prepare(
    `SELECT ei.id, ei.short_id, ei.subject, ei.knowledge_tags, ei.text_excerpt, ei.status, ei.next_review_at,
            mil.job_id, er.confidence_badge,
            ra.completion AS att_completion, ra.correct AS att_correct
     FROM review_packet_item rpi
     JOIN error_item ei ON ei.id = rpi.item_id
     JOIN mobile_item_link mil ON mil.item_id = ei.id
     LEFT JOIN evidence_record er ON er.item_id = ei.id
     LEFT JOIN review_attempt ra ON ra.packet_id = rpi.packet_id AND ra.item_id = rpi.item_id
     WHERE rpi.packet_id = ?
     ORDER BY rpi.position`,
  ).all(packetId) as unknown as SummaryRow[];

  const toCard = (row: SummaryRow): V2WeekItem => ({
    id: row.id,
    shortId: row.short_id,
    subject: row.subject,
    knowledgeTags: JSON.parse(row.knowledge_tags) as string[],
    questionExcerpt: row.text_excerpt,
    badge: row.confidence_badge === 'low' ? 'low' : 'ok',
    status: row.status,
    cropUrl: `/v2/items/${row.id}/crop`,
    jobId: row.job_id,
  });
  const isIndependentCorrect = (row: SummaryRow): boolean => row.att_completion === 'independent' && row.att_correct === 1;

  // 校准基数（R1-F1）：本包已回传、且最近一次复盘（rowid 最大者）把握程度 ≥ 2 的题。
  // 未回传的题不计入（学生还没录，不能说"没独立做出来"）；多次复盘只看最近一次。
  const confidentRows = db.prepare(
    `SELECT rpi.item_id FROM review_packet_item rpi
     JOIN error_diagnosis d ON d.item_id = rpi.item_id
     WHERE rpi.packet_id = ?
       AND d.rowid = (SELECT MAX(rowid) FROM error_diagnosis WHERE item_id = rpi.item_id)
       AND d.mastery_feeling >= 2`,
  ).all(packetId) as Array<{ item_id: string }>;
  const confidentIds = new Set(confidentRows.map(row => row.item_id));
  const confidentReturned = rows.filter(row => row.att_completion !== null && confidentIds.has(row.id));
  const missed = confidentReturned.filter(row => !isIndependentCorrect(row));

  const confirmDates = rows
    .filter(row => row.status === 'temporarily_mastered' && row.next_review_at !== null && isIndependentCorrect(row))
    .map(row => (row.next_review_at as string).slice(0, 10))
    .sort();

  return {
    answered: rows.filter(row => row.att_completion !== null).length,
    total: rows.length,
    independentCorrect: rows.filter(isIndependentCorrect).length,
    masteredNow: rows
      .filter(row => row.att_completion !== null
        && (row.status === 'temporarily_mastered' || row.status === 'stably_mastered'))
      .map(toCard),
    again: rows
      .filter(row => row.status === 'needs_recheck')
      .map(row => ({ ...toCard(row), reason: (row.att_completion ? AGAIN_REASON[row.att_completion] : undefined) ?? '需再做一次' })),
    calibration: {
      confidentTotal: confidentReturned.length,
      missedCount: missed.length,
      text: confidentReturned.length === 0 ? null : `你说有把握的 ${confidentReturned.length} 道里，${missed.length} 道没独立做出来`,
      items: missed.map(toCard),
    },
    nextConfirmOn: confirmDates[0] ?? null,
  };
}
