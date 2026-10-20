/**
 * v2.0 T4c：AI 追问与复盘。
 * AI 只提问和归纳——不讲题、不给答案、不替学生写；复盘由学生本人最终确认提交。
 * 一次追问最多两轮；单题最多 3 次模型调用（提问 1 + 归纳 1 + 第二轮归纳 1），
 * 由结构保证：ask 只在建第 1 轮时调模型，answer 只在第 1、2 轮归纳，第 3 次 answer 直接 409。
 * 学生原话与 AI 归纳只存库、只给学生本人看：audit 只记 ID，家长聚合不读这两列。
 */
import { getFollowupProvider } from '../ai/index.js';
import { FOLLOWUP_FALLBACK_QUESTION, FOLLOWUP_FALLBACK_SELECTED_QUESTION, type FollowupSummarize } from '../ai/evidence.js';
import type { FollowupProvider, FollowupTurn } from '../ai/provider.js';
import { getDb, newId, now } from '../db/connection.js';
import { statusAfterReflection } from '../domain/stateMachine.js';
import { ATTEMPT_STATES, CAUSES, type AttemptState, type Cause, type ItemStatus, type MasteryFeeling } from '../domain/types.js';
import { audit } from '../services/eventLog.js';
import { getLearningContext, getLearningSource, learningEligible } from '../learning/sources.js';
import { getItem } from '../services/itemService.js';

export const MAX_TURNS = 2;
const ANSWER_MAX_CHARS = 300;

export interface ReflectionTurnView { turn: number; question: string; source: 'ai' | 'fallback'; answer: string | null }
export interface ReflectionSuggestionView { summary: string; suggestedCause: Cause; suggestedAttemptState: AttemptState }
export interface ReflectionView {
  id: string; attemptState: AttemptState; cause: Cause; masteryFeeling: MasteryFeeling;
  summary: string | null; adoptedAi: boolean; source: string; createdAt: string;
}

export type AskResult =
  | { ok: true; turn: number; question: string; source: 'ai' | 'fallback' }
  | { ok: false; httpStatus: 404 | 409; message: string };

export type AnswerResult =
  | { ok: true; turn: number; summary: string | null; suggestedCause: Cause | null; suggestedAttemptState: AttemptState | null; secondQuestion: string | null }
  | { ok: false; httpStatus: 400 | 404 | 409; message: string };

export type SubmitResult =
  | { ok: true; reflection: ReflectionView; status: ItemStatus }
  | { ok: false; httpStatus: 400 | 404; message: string };

interface TurnRow {
  id: string; item_id: string; turn: number; question: string; question_source: string;
  answer: string | null; summary_json: string | null; created_at: string; answered_at: string | null;
}

function notLearning(itemId: string): boolean {
  return !getItem(itemId) || !getLearningSource(itemId);
}

function turnsOf(itemId: string): TurnRow[] {
  return getDb().prepare('SELECT * FROM v2_reflection_turn WHERE item_id = ? ORDER BY turn').all(itemId) as unknown as TurnRow[];
}

function latestSuggestion(itemId: string): FollowupSummarize | null {
  const rows = turnsOf(itemId);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.summary_json) {
      try { return JSON.parse(rows[i]!.summary_json!) as FollowupSummarize; } catch { return null; }
    }
  }
  return null;
}

/**
 * 发起/续取追问。幂等：已有未回答的问题时原样返回，不再调用模型。
 * 规则 3：证据里有学生作答或订正才调模型；否则直接固定开放句（source=fallback，不调模型）。
 * 提问失败（模型/校验）退回固定开放句，不重试。
 */
export async function askFollowup(itemId: string, provider?: FollowupProvider): Promise<AskResult> {
  if (notLearning(itemId)) return { ok: false, httpStatus: 404, message: '题目不存在或不属于手机上传。' };
  if (!learningEligible(itemId) || !getLearningContext(itemId)) return {ok:false,httpStatus:409,message:'请先补齐并关联题目材料。'};
  const db = getDb();
  const pending = turnsOf(itemId).find(t => t.answer === null);
  if (pending) return { ok: true, turn: pending.turn, question: pending.question, source: pending.question_source as 'ai' | 'fallback' };
  const turns = turnsOf(itemId);
  // 已有轮次且无待回答问题：要么第 1 轮归纳后无需第 2 轮，要么两轮已满——追问都已结束。
  if (turns.length > 0) return { ok: false, httpStatus: 409, message: '追问已结束（最多两轮），请提交复盘。' };

  const evidence = getLearningContext(itemId);
  const studentMaterial = evidence?.context.observations.filter(o => o.kind === 'student_work' || o.kind === 'correction') ?? [];
  // S1-R1：固定句二选一——学生自己勾入的题（答案在答题卡上、卷面干净）且证据里没有学生作答/订正时，
  // "卡在哪一步"问偏了（学生其实答了，只是卷面看不到），改用"怎么做的/答案写的什么"。
  // 有学生作答或订正 → 调模型；模型失败时的退回句按同一规则二选一。
  const selectedByStudent = (db.prepare('SELECT selected_by_student FROM mobile_item_link WHERE item_id = ? LIMIT 1').get(itemId) as { selected_by_student: number } | undefined)?.selected_by_student === 1;
  const fallbackQuestion = selectedByStudent && studentMaterial.length === 0 ? FOLLOWUP_FALLBACK_SELECTED_QUESTION : FOLLOWUP_FALLBACK_QUESTION;
  let question = fallbackQuestion;
  let source: 'ai' | 'fallback' = 'fallback';
  if (evidence && studentMaterial.length > 0) {
    try {
      const asked = await (provider ?? getFollowupProvider()).followupAsk(evidence.context);
      question = asked.question;
      source = 'ai';
    } catch {
      // 校验/模型失败：退回固定开放句，不重试。
    }
  }
  db.prepare('INSERT INTO v2_reflection_turn (id, item_id, turn, question, question_source, created_at) VALUES (?,?,?,?,?,?)')
    .run(newId('rtn'), itemId, 1, question, source, now());
  audit('v2_reflection_asked', 'item', itemId);
  return { ok: true, turn: 1, question, source };
}

/**
 * 回答当前轮追问并归纳。归纳失败返回 summary=null（学生手选错因与状态），不重试。
 * 有 secondQuestion 且当前为第 1 轮时，它成为第 2 轮的问题；第 2 轮回答后不再追问。
 */
export async function answerFollowup(itemId: string, body: unknown, provider?: FollowupProvider): Promise<AnswerResult> {
  if (notLearning(itemId)) return { ok: false, httpStatus: 404, message: '题目不存在或不属于手机上传。' };
  if (!learningEligible(itemId) || !getLearningContext(itemId)) return {ok:false,httpStatus:409,message:'请先补齐并关联题目材料。'};
  const answer = typeof (body as { answer?: unknown })?.answer === 'string' ? (body as { answer: string }).answer.trim() : '';
  if (!answer || answer.length > ANSWER_MAX_CHARS) return { ok: false, httpStatus: 400, message: '回答需要 1–300 字。' };

  const db = getDb();
  const pending = turnsOf(itemId).find(t => t.answer === null);
  if (!pending) return { ok: false, httpStatus: 409, message: '当前没有待回答的追问。' };

  const evidence = getLearningContext(itemId);
  const priorTurns: FollowupTurn[] = turnsOf(itemId)
    .filter(t => t.answer !== null)
    .map(t => ({ question: t.question, answer: t.answer! }));
  const turns: FollowupTurn[] = [...priorTurns, { question: pending.question, answer }];

  let summarized: FollowupSummarize | null = null;
  if (evidence) {
    try {
      summarized = await (provider ?? getFollowupProvider()).followupSummarize(evidence.context, turns);
    } catch {
      summarized = null;
    }
  }

  db.prepare('UPDATE v2_reflection_turn SET answer = ?, summary_json = ?, answered_at = ? WHERE id = ?')
    .run(answer, summarized ? JSON.stringify(summarized) : null, now(), pending.id);

  // 第二轮问题：仅第 1 轮回答后、且归纳给出 secondQuestion 时产生。第 2 轮回答后不再追问。
  let secondQuestion: string | null = null;
  if (pending.turn === 1 && summarized?.secondQuestion) {
    secondQuestion = summarized.secondQuestion;
    db.prepare('INSERT INTO v2_reflection_turn (id, item_id, turn, question, question_source, created_at) VALUES (?,?,?,?,?,?)')
      .run(newId('rtn'), itemId, 2, secondQuestion, 'ai', now());
  }
  audit('v2_reflection_answered', 'item', itemId);
  return {
    ok: true, turn: pending.turn,
    summary: summarized?.summary ?? null,
    suggestedCause: summarized?.suggestedCause ?? null,
    suggestedAttemptState: summarized?.suggestedAttemptState ?? null,
    secondQuestion,
  };
}

/**
 * 最终提交：全部由学生确认或修改后提交。adopted_ai=1 仅当 attemptState 与 cause
 * 都等于最近一次 AI 建议。可重复提交（新记录覆盖式呈现，旧记录保留）。
 */
export function submitV2Reflection(itemId: string, body: unknown): SubmitResult {
  if (notLearning(itemId)) return { ok: false, httpStatus: 404, message: '题目不存在或不属于手机上传。' };
  const input = (body ?? {}) as Record<string, unknown>;
  const attemptState = typeof input.attemptState === 'string' ? input.attemptState : '';
  const cause = typeof input.cause === 'string' ? input.cause : '';
  const masteryFeeling = input.masteryFeeling;
  const summary = input.summary === undefined ? undefined : input.summary;
  if (!(ATTEMPT_STATES as readonly string[]).includes(attemptState)) return { ok: false, httpStatus: 400, message: '做题状态不合法。' };
  if (!(CAUSES as readonly string[]).includes(cause)) return { ok: false, httpStatus: 400, message: '错因不合法。' };
  if (typeof masteryFeeling !== 'number' || !Number.isInteger(masteryFeeling) || masteryFeeling < 0 || masteryFeeling > 3) {
    return { ok: false, httpStatus: 400, message: '把握程度需要 0–3。' };
  }
  if (summary !== undefined && (typeof summary !== 'string' || summary.length > 60)) {
    return { ok: false, httpStatus: 400, message: '归纳不超过 60 字。' };
  }

  const db = getDb();
  const item = getItem(itemId)!;
  const suggestion = latestSuggestion(itemId);
  const adoptedAi = !!suggestion && suggestion.suggestedCause === cause && suggestion.suggestedAttemptState === attemptState;
  const studentWords = turnsOf(itemId).filter(t => t.answer !== null).map(t => t.answer!).join('\n');
  // confirmed_summary：学生确认或改写后的归纳；未提交 summary 时落 AI 归纳（若有）。ai_summary 只存 AI 原文。
  const confirmedSummary = (summary as string | undefined) ?? suggestion?.summary ?? null;
  const id = newId('dia');
  db.prepare(
    `INSERT INTO error_diagnosis (id, item_id, attempt_state, cause, mastery_feeling, review_value, submitted_by, adopted_ai, source, student_words, ai_summary, confirmed_summary, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, itemId, attemptState, cause, masteryFeeling, '必须再做', 'student', adoptedAi ? 1 : 0, 'v2',
    studentWords || null, suggestion?.summary ?? null, confirmedSummary, now());

  const transition = statusAfterReflection(item.status);
  if (transition.to !== item.status) {
    db.prepare('UPDATE error_item SET status = ?, updated_at = ? WHERE id = ?').run(transition.to, now(), itemId);
  }
  audit('v2_reflection_submitted', 'item', itemId);
  return {
    ok: true,
    reflection: {
      id, attemptState: attemptState as AttemptState, cause: cause as Cause,
      masteryFeeling: masteryFeeling as MasteryFeeling, summary: confirmedSummary,
      adoptedAi, source: 'v2', createdAt: now(),
    },
    status: transition.to,
  };
}

/** 该题的追问轮次（含学生原话）、最近一次 AI 建议、最新复盘。仅学生端使用。 */
export function getV2Reflection(itemId: string): { turns: ReflectionTurnView[]; suggestion: ReflectionSuggestionView | null; reflection: ReflectionView | null } | null {
  if (notLearning(itemId)) return null;
  const turns = turnsOf(itemId).map(t => ({
    turn: t.turn, question: t.question, source: t.question_source as 'ai' | 'fallback', answer: t.answer,
  }));
  const suggestion = latestSuggestion(itemId);
  const row = getDb().prepare(
    'SELECT * FROM error_diagnosis WHERE item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
  ).get(itemId) as { id: string; attempt_state: string; cause: string; mastery_feeling: number; adopted_ai: number; source: string; ai_summary: string | null; confirmed_summary: string | null; created_at: string } | undefined;
  return {
    turns,
    suggestion: suggestion ? { summary: suggestion.summary, suggestedCause: suggestion.suggestedCause, suggestedAttemptState: suggestion.suggestedAttemptState } : null,
    reflection: row ? {
      id: row.id, attemptState: row.attempt_state as AttemptState, cause: row.cause as Cause,
      masteryFeeling: row.mastery_feeling as MasteryFeeling, summary: row.confirmed_summary,
      adoptedAi: row.adopted_ai === 1, source: row.source, createdAt: row.created_at,
    } : null,
  };
}
