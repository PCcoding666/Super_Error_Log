/**
 * 学生端详情页：AI 参考答案、解题过程与推测错因，以及学生自己记的备注。
 * AI 只读题目识别结果（题干和笔迹转写），不改证据、不写反思；推测错因只依据学生原作，没有原作就不推测（不靠模型自觉）。
 * 按题目内容指纹缓存：同一内容成功生成一次就不再调用模型；修改识别结果后指纹变了，旧解答不再显示，重新生成。
 * 模型可能要几十秒，生成在后台跑：请求立即返回「生成中」，客户端轮询。每题每小时最多 6 次模型调用（成功、失败都计入）。
 * 解答、错因、备注只存库、只给学生本人看：audit 只记 ID。
 */
import { createHash } from 'node:crypto';
import { getInsightProvider } from '../ai/index.js';
import { AiError } from '../ai/errors.js';
import type { Insight } from '../ai/evidence.js';
import type { InsightProvider } from '../ai/provider.js';
import { getDb, newId, now } from '../db/connection.js';
import type { LearningContext } from '../learning/contracts.js';
import { getLearningContext } from '../learning/sources.js';
import { audit } from '../services/eventLog.js';

export const INSIGHT_RATE_LIMIT = 6;
const INSIGHT_RATE_WINDOW_MS = 60 * 60 * 1000;
export const NOTE_MAX_CHARS = 1000;
/** 改了提示词或输入材料的形状就升版本，旧缓存随之失效。 */
const BASIS_VERSION = 'item-explain-v1';

export type InsightState =
  | { state: 'unavailable' }
  | { state: 'none' }
  | { state: 'generating' }
  | { state: 'ready'; insight: Insight; requiresDiagram: boolean }
  | { state: 'failed'; rateLimited: boolean };

export interface ItemNoteRecord { text: string; updatedAt: string | null }

interface Basis { hash: string; context: LearningContext }

/** 同一进程（一个学生一个 worker）里正在生成的题；同一指纹不重复调用模型。 */
const running = new Map<string, { hash: string; done: Promise<void> }>();

function basisOf(itemId: string): Basis | null {
  const current = getLearningContext(itemId);
  if (!current?.context.questionText.trim()) return null;
  const c = current.context;
  const material = { questionText: c.questionText, subject: c.subject, requiresDiagram: c.requiresDiagram, observations: c.observations.map(o => [o.kind, o.text]), uncertainties: c.uncertainties };
  return { hash: createHash('sha256').update(JSON.stringify([BASIS_VERSION, material])).digest('hex'), context: c };
}

function rateLimited(itemId: string): boolean {
  const cutoff = new Date(Date.now() - INSIGHT_RATE_WINDOW_MS).toISOString();
  return (getDb().prepare('SELECT COUNT(*) AS n FROM item_insight WHERE item_id = ? AND created_at > ?').get(itemId, cutoff) as { n: number }).n >= INSIGHT_RATE_LIMIT;
}

function stateFor(itemId: string, basis: Basis): InsightState {
  if (running.get(itemId)?.hash === basis.hash) return { state: 'generating' };
  const row = getDb().prepare('SELECT content_json FROM item_insight WHERE item_id = ? AND basis_hash = ? ORDER BY content_json IS NULL, rowid DESC LIMIT 1')
    .get(itemId, basis.hash) as { content_json: string | null } | undefined;
  if (!row) return { state: 'none' };
  if (row.content_json) return { state: 'ready', insight: JSON.parse(row.content_json) as Insight, requiresDiagram: basis.context.requiresDiagram };
  return { state: 'failed', rateLimited: rateLimited(itemId) };
}

async function generate(itemId: string, basis: Basis, explainer: InsightProvider): Promise<void> {
  let content: Insight | null = null;
  let error: string | null = null;
  try {
    content = (await explainer.explainItem(basis.context)).value;
    if (!basis.context.observations.some(o => o.kind === 'student_work')) content = { ...content, mistake: null, cause: null };
  } catch (caught) {
    error = caught instanceof AiError ? caught.kind : 'internal';
  }
  getDb().prepare('INSERT INTO item_insight (id, item_id, basis_hash, content_json, error, created_at) VALUES (?,?,?,?,?,?)')
    .run(newId('ins'), itemId, basis.hash, content ? JSON.stringify(content) : null, error, now());
  audit(content ? 'item_insight_ready' : 'item_insight_failed', 'item', itemId);
}

/** 当前内容的解答状态；不调用模型。 */
export function insightState(itemId: string): InsightState {
  const basis = basisOf(itemId);
  return basis ? stateFor(itemId, basis) : { state: 'unavailable' };
}

/** 没有可用的解答就在后台开始生成（已有、正在生成、超过限流都不再调用模型）。 */
export function requestInsight(itemId: string, provider?: InsightProvider): InsightState {
  const basis = basisOf(itemId);
  if (!basis) return { state: 'unavailable' };
  const current = stateFor(itemId, basis);
  if (current.state === 'ready' || current.state === 'generating') return current;
  if (rateLimited(itemId)) return { state: 'failed', rateLimited: true };
  const explainer = provider ?? getInsightProvider();
  // 后台任务的任何异常（例如生成期间题目被删、外键写不进去）都不能变成未处理的 rejection 拖垮 worker。
  const done: Promise<void> = generate(itemId, basis, explainer)
    .catch(() => undefined)
    .finally(() => { if (running.get(itemId)?.done === done) running.delete(itemId); });
  running.set(itemId, { hash: basis.hash, done });
  return { state: 'generating' };
}

/** 还有解答在后台生成：worker 不因空闲退出。 */
export function insightWorkPending(): boolean {
  return running.size > 0;
}

/** 测试用：等这道题正在跑的生成结束。 */
export function settleInsight(itemId: string): Promise<void> {
  return running.get(itemId)?.done ?? Promise.resolve();
}

export function getItemNote(itemId: string): ItemNoteRecord {
  const row = getDb().prepare('SELECT text, updated_at FROM item_note WHERE item_id = ?').get(itemId) as { text: string; updated_at: string } | undefined;
  return row ? { text: row.text, updatedAt: row.updated_at } : { text: '', updatedAt: null };
}

/** 保存备注；清空就删掉。返回 null 表示内容不合法。 */
export function saveItemNote(itemId: string, text: unknown): ItemNoteRecord | null {
  if (typeof text !== 'string' || text.length > NOTE_MAX_CHARS) return null;
  const db = getDb();
  if (!text.trim()) {
    db.prepare('DELETE FROM item_note WHERE item_id = ?').run(itemId);
    audit('item_note_cleared', 'item', itemId);
    return { text: '', updatedAt: null };
  }
  const updatedAt = now();
  db.prepare('INSERT INTO item_note (item_id, text, updated_at) VALUES (?,?,?) ON CONFLICT(item_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at')
    .run(itemId, text, updatedAt);
  audit('item_note_saved', 'item', itemId);
  return { text, updatedAt };
}
