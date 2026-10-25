/**
 * 学生端详情页：AI 参考答案、解题过程、推测错因、交互图，学生拍照录入的答案，以及学生自己记的备注。
 *
 * 全部在后台排队做（2026-10-24 用户要求）：题收进错题本后，等这个学生没有在上传 / 识别 / 整理材料 / 准备打印时，
 * 一次一道地生成；向父进程借模型名额时也排在所有学生的前台请求之后（permits.ts）。打开详情页只是把这道题排到最前，不会马上调用模型。
 * - 看题目照片（旧流程整题图、材料裁图）和识别出的文字，学生拍的答案转写作参考；
 * - 推测错因只依据学生原作，没有原作就不推测（服务器强制，不靠模型自觉）；
 * - 按题目内容指纹缓存：同一内容成功一次就不再调用模型；修改识别结果、录入答案后指纹变了，重新排队；
 * - 失败自动再试一次；还不行就等学生点「重试」。每题每小时最多 6 次讲解调用（成功、失败都计入）；
 * - 只自动处理最近 SEL_INSIGHT_BACKFILL_DAYS 天（缺省 30）录入的题，更早的题打开详情页时再排队。
 * 解答、错因、答案照片、备注只存库、只给学生本人看：audit 只记 ID。
 */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { getInsightProvider } from '../ai/index.js';
import { AiError } from '../ai/errors.js';
import type { Insight } from '../ai/evidence.js';
import type { InsightProvider } from '../ai/provider.js';
import { getDb, newId, now } from '../db/connection.js';
import type { LearningContext } from '../learning/contracts.js';
import { getLearningContext, getLearningSource, learningImageFragments, learningIncluded, materialStoreForItem } from '../learning/sources.js';
import { readFragmentImage } from '../materials/media.js';
import { withProcessImage } from '../mobile/admission.js';
import { PreemptedError } from '../studentHost/parentPermit.js';
import { audit } from '../services/eventLog.js';
import { ensureStudentProfile } from '../services/studentService.js';
import { getItemFullCrop } from './fullCrop.js';

export const INSIGHT_RATE_LIMIT = 6;
const INSIGHT_RATE_WINDOW_MS = 60 * 60 * 1000;
/** 后台自动尝试次数（每个内容版本）；用完了等学生点重试。 */
const AUTO_ATTEMPTS = 2;
const AUTO_RETRY_DELAY_MS = 2 * 60 * 1000;
export const NOTE_MAX_CHARS = 1000;
export const ANSWER_PHOTO_LIMIT = 3;
export const ANSWER_TEXT_MAX_CHARS = 8000;
const ANSWER_READ_ATTEMPTS = 2;
const IMAGE_EDGE = 1600;
const MAX_IMAGES = 6;
const SCAN_BATCH = 20;
const SCAN_PAUSE_MS = 10 * 60 * 1000;
const UNAVAILABLE_RECHECK_MS = 30 * 60 * 1000;
/** 改了提示词或输入材料的形状就升版本，旧缓存随之失效。 */
const BASIS_VERSION = 'item-explain-v2';

/**
 * none：还没轮到（后台会做）；queued：排在前面或等着自动再试；generating：正在生成；
 * failed：自动尝试用完了（rateLimited 为 true 时一小时内不能再试）。
 */
export type InsightState =
  | { state: 'unavailable' }
  | { state: 'none' }
  | { state: 'queued' }
  | { state: 'generating' }
  | { state: 'ready'; insight: Insight; requiresDiagram: boolean; images: number }
  | { state: 'failed'; rateLimited: boolean };

export interface ItemNoteRecord { text: string; updatedAt: string | null }
export type AnswerPhotoStatus = 'reading' | 'done' | 'not_found' | 'failed';
export interface AnswerPhotoRecord { id: string; status: AnswerPhotoStatus; text: string | null; createdAt: string }

interface Basis { hash: string; context: LearningContext; providedAnswers: string[] }
interface StoredInsight extends Insight { images: number }

export interface InsightQueueOptions {
  /** 这个学生正忙（上传、识别、整理材料、准备打印）：先不做。 */
  busy: () => boolean;
  /** 定时检查间隔；0 表示不开定时器（测试里手动 drainInsightQueue）。 */
  intervalMs?: number;
  provider?: InsightProvider;
  /** 只自动处理最近多少天录入的题；0 表示只处理学生打开过的题。 */
  backfillDays?: number;
}

const running = new Map<string, string>();
const priority: Array<{ itemId: string; manual: boolean }> = [];
/** 学生要过的题（打开过、改过、录过答案）：不管录入多久，都一直留着，直到解出来或自动次数用完。 */
const requested = new Set<string>();
const unavailableUntil = new Map<string, number>();
let queue: { options: InsightQueueOptions; timer: NodeJS.Timeout | null } | null = null;
let draining: Promise<void> | null = null;
let busyWith: string | null = null;
let scanCursor = 0;
let scanPausedUntil = 0;

function providedAnswers(itemId: string): string[] {
  return (getDb().prepare("SELECT text FROM item_answer_photo WHERE item_id = ? AND status = 'done' AND text IS NOT NULL ORDER BY created_at").all(itemId) as Array<{ text: string }>).map(row => row.text);
}

function basisOf(itemId: string): Basis | null {
  const current = getLearningContext(itemId);
  if (!current?.context.questionText.trim()) return null;
  const c = current.context;
  const answers = providedAnswers(itemId);
  const material = { revision: current.revision, questionText: c.questionText, subject: c.subject, requiresDiagram: c.requiresDiagram, observations: c.observations.map(o => [o.kind, o.text]), uncertainties: c.uncertainties, answers };
  return { hash: createHash('sha256').update(JSON.stringify([BASIS_VERSION, material])).digest('hex'), context: c, providedAnswers: answers };
}

function rateLimited(itemId: string): boolean {
  const cutoff = new Date(Date.now() - INSIGHT_RATE_WINDOW_MS).toISOString();
  return (getDb().prepare('SELECT COUNT(*) AS n FROM item_insight WHERE item_id = ? AND created_at > ?').get(itemId, cutoff) as { n: number }).n >= INSIGHT_RATE_LIMIT;
}

function recordFor(itemId: string, hash: string): { content: StoredInsight | null; failures: number; lastFailureAt: string | null } {
  const rows = getDb().prepare('SELECT content_json, created_at FROM item_insight WHERE item_id = ? AND basis_hash = ? ORDER BY rowid DESC').all(itemId, hash) as Array<{ content_json: string | null; created_at: string }>;
  const ready = rows.find(row => row.content_json);
  const failures = rows.filter(row => !row.content_json);
  return { content: ready ? JSON.parse(ready.content_json!) as StoredInsight : null, failures: failures.length, lastFailureAt: failures[0]?.created_at ?? null };
}

function stateFor(itemId: string, basis: Basis): InsightState {
  if (running.get(itemId) === basis.hash) return { state: 'generating' };
  const record = recordFor(itemId, basis.hash);
  if (record.content) {
    const { images = 0, ...insight } = record.content;
    return { state: 'ready', insight: { ...insight, figure: insight.figure ?? null }, requiresDiagram: basis.context.requiresDiagram, images };
  }
  if (priority.some(entry => entry.itemId === itemId && (entry.manual || record.failures < AUTO_ATTEMPTS))) return { state: 'queued' };
  if (requested.has(itemId) && record.failures < AUTO_ATTEMPTS) return { state: 'queued' };
  const limited = rateLimited(itemId);
  if (record.failures >= AUTO_ATTEMPTS || (record.failures > 0 && limited)) return { state: 'failed', rateLimited: limited };
  return { state: record.failures > 0 ? 'queued' : 'none' };
}

/** 这道题现在要不要调用模型。manual：学生点了重试，不受自动次数限制（仍受每小时上限）。 */
function wantsWork(itemId: string, basis: Basis, manual: boolean): boolean {
  if (running.has(itemId) || rateLimited(itemId)) return false;
  const record = recordFor(itemId, basis.hash);
  if (record.content) return false;
  if (manual) return true;
  if (record.failures >= AUTO_ATTEMPTS) return false;
  return !record.lastFailureAt || Date.now() - Date.parse(record.lastFailureAt) >= AUTO_RETRY_DELAY_MS;
}

/** 题目照片：旧流程整题图（含作答和批改）加上材料裁图，缩到长边 1600；读不到就只给文字。 */
async function questionImages(itemId: string): Promise<Buffer[]> {
  try {
    return await withProcessImage(async () => {
      const raw: Buffer[] = [];
      if (getLearningSource(itemId)?.kind === 'legacy') raw.push(await getItemFullCrop(itemId));
      const store = materialStoreForItem(itemId);
      if (store) for (const fragment of learningImageFragments(itemId).slice(0, MAX_IMAGES - raw.length)) raw.push(await readFragmentImage(store, fragment.fragmentId, fragment.revision));
      return Promise.all(raw.map(bytes => sharp(bytes, { limitInputPixels: 40_000_000 }).resize({ width: IMAGE_EDGE, height: IMAGE_EDGE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()));
    }, { background: true });
  } catch { return []; }
}

async function runInsight(itemId: string, basis: Basis, explainer: InsightProvider): Promise<void> {
  running.set(itemId, basis.hash);
  try {
    let content: StoredInsight | null = null;
    let error: string | null = null;
    try {
      const images = await questionImages(itemId);
      const value = (await explainer.explainItem({ context: basis.context, images, providedAnswers: basis.providedAnswers, background: true })).value;
      const noWork = !basis.context.observations.some(o => o.kind === 'student_work');
      content = { ...value, ...(noWork ? { mistake: null, cause: null } : {}), images: images.length };
    } catch (caught) {
      // 名额让给了前台请求：不算失败，排回最前，等下次空闲再做。
      if (caught instanceof PreemptedError) { priority.unshift({ itemId, manual: false }); return; }
      error = caught instanceof AiError ? caught.kind : 'internal';
    }
    // 生成期间题目可能被删（外键写不进去）：后台任务吞掉，不能拖垮 worker。
    try {
      getDb().prepare('INSERT INTO item_insight (id, item_id, basis_hash, content_json, error, created_at) VALUES (?,?,?,?,?,?)')
        .run(newId('ins'), itemId, basis.hash, content ? JSON.stringify(content) : null, error, now());
      audit(content ? 'item_insight_ready' : 'item_insight_failed', 'item', itemId);
    } catch { /* 题目已不在 */ }
  } finally { running.delete(itemId); }
}

async function runAnswerPhoto(photoId: string, itemId: string, reader: InsightProvider): Promise<void> {
  const db = getDb();
  const row = db.prepare("SELECT image, attempts FROM item_answer_photo WHERE id = ? AND item_id = ? AND status = 'reading'").get(photoId, itemId) as { image: Uint8Array; attempts: number } | undefined;
  if (!row) return;
  let status: AnswerPhotoStatus; let text: string | null = null; let error: string | null = null;
  try {
    const context = getLearningContext(itemId)?.context;
    if (!context?.questionText.trim()) throw new AiError('unsupported', '题目文字还不完整');
    const reading = (await reader.readAnswerPhoto({ context, photo: Buffer.from(row.image), background: true })).value;
    status = reading.found ? 'done' : 'not_found';
    text = reading.text;
  } catch (caught) {
    // 名额让给了前台请求：照片还在「转写中」，不计次数，下次空闲再做。
    if (caught instanceof PreemptedError) return;
    error = caught instanceof AiError ? caught.kind : 'internal';
    status = row.attempts + 1 >= ANSWER_READ_ATTEMPTS ? 'failed' : 'reading';
  }
  try {
    // 学生在转写期间自己改了文字（status 已不是 reading）就不覆盖。
    const changed = db.prepare("UPDATE item_answer_photo SET status = ?, text = ?, attempts = attempts + 1, error = ?, updated_at = ? WHERE id = ? AND status = 'reading'")
      .run(status, text, error, now(), photoId).changes;
    if (changed && status !== 'reading') audit(`item_answer_photo_${status}`, 'item', itemId);
  } catch { /* 题目已不在 */ }
  if (status === 'done') prioritizeInsight(itemId);
}

function eligibleItems(options: InsightQueueOptions, onlyWithoutInsight: boolean): string[] {
  const days = options.backfillDays ?? 30;
  if (days <= 0) return [];
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  return (getDb().prepare(`SELECT id FROM error_item WHERE student_id = ? AND created_at >= ?
    AND NOT (status = 'archived_not_worth_review' AND archived_reason = 'not_a_mistake')
    ${onlyWithoutInsight ? 'AND NOT EXISTS (SELECT 1 FROM item_insight s WHERE s.item_id = error_item.id)' : ''}
    ORDER BY created_at DESC, id`).all(ensureStudentProfile().id, since) as Array<{ id: string }>).map(row => row.id);
}

/** 自动处理的题：在错题本里、文字够、要做。题干还没识别完整的过半小时再看。 */
function autoCandidate(itemId: string): Basis | null {
  if ((unavailableUntil.get(itemId) ?? 0) > Date.now() || !getLearningSource(itemId) || !learningIncluded(itemId)) return null;
  const basis = basisOf(itemId);
  if (!basis) { unavailableUntil.set(itemId, Date.now() + UNAVAILABLE_RECHECK_MS); return null; }
  return wantsWork(itemId, basis, false) ? basis : null;
}

/** 找下一件事：先转写拍的答案（讲解要用），再做学生打开过的题，再做新收的题，最后慢慢扫一遍内容改过的题。 */
function nextJob(options: InsightQueueOptions): { label: string; run: (provider: InsightProvider) => Promise<void> } | null {
  const photo = getDb().prepare("SELECT p.id, p.item_id FROM item_answer_photo p JOIN error_item i ON i.id = p.item_id WHERE p.status = 'reading' AND i.student_id = ? ORDER BY p.created_at LIMIT 1")
    .get(ensureStudentProfile().id) as { id: string; item_id: string } | undefined;
  if (photo) return { label: `answer:${photo.item_id}`, run: provider => runAnswerPhoto(photo.id, photo.item_id, provider) };
  while (priority.length) {
    const entry = priority.shift()!;
    const basis = getLearningSource(entry.itemId) ? basisOf(entry.itemId) : null;
    if (basis && wantsWork(entry.itemId, basis, entry.manual)) return { label: `insight:${entry.itemId}`, run: provider => runInsight(entry.itemId, basis, provider) };
  }
  // 学生要过的题：失败后的自动再试不受录入时间范围限制；解出来、自动次数用完或题目没了就不再留着。
  for (const itemId of [...requested]) {
    const basis = getLearningSource(itemId) ? basisOf(itemId) : null;
    const record = basis && recordFor(itemId, basis.hash);
    if (!basis || !record || record.content || record.failures >= AUTO_ATTEMPTS) { requested.delete(itemId); continue; }
    if (wantsWork(itemId, basis, false)) return { label: `insight:${itemId}`, run: provider => runInsight(itemId, basis, provider) };
  }
  for (const itemId of eligibleItems(options, true)) {
    const basis = autoCandidate(itemId);
    if (basis) return { label: `insight:${itemId}`, run: provider => runInsight(itemId, basis, provider) };
  }
  if (Date.now() < scanPausedUntil) return null;
  const all = eligibleItems(options, false);
  for (const itemId of all.slice(scanCursor, scanCursor + SCAN_BATCH)) {
    scanCursor += 1;
    const basis = autoCandidate(itemId);
    if (basis) return { label: `insight:${itemId}`, run: provider => runInsight(itemId, basis, provider) };
  }
  if (scanCursor >= all.length) { scanCursor = 0; scanPausedUntil = Date.now() + SCAN_PAUSE_MS; }
  return null;
}

/** 有事就一件一件做，直到没事或者忙起来。同一时间只有一个在跑。 */
export function drainInsightQueue(): Promise<void> {
  if (draining) return draining;
  if (!queue) return Promise.resolve();
  const options = queue.options;
  draining = (async () => {
    while (queue && !options.busy()) {
      const job = nextJob(options);
      if (!job) break;
      busyWith = job.label;
      try { await job.run(options.provider ?? getInsightProvider()); } finally { busyWith = null; }
    }
  })().catch(() => undefined).finally(() => { draining = null; });
  return draining;
}

/** 启动后台队列（每个学生进程一个）；返回停止函数。再次调用只更新参数。 */
export function startInsightQueue(options: InsightQueueOptions): () => void {
  if (queue?.timer) clearInterval(queue.timer);
  const intervalMs = options.intervalMs ?? 15_000;
  const timer = intervalMs > 0 ? setInterval(() => { void drainInsightQueue(); }, intervalMs) : null;
  timer?.unref();
  queue = { options, timer };
  if (timer) setImmediate(() => { void drainInsightQueue(); });
  return () => { if (queue?.timer === timer) { if (timer) clearInterval(timer); queue = null; } };
}

/** 把这道题排到最前（打开详情页、修改识别结果、录入答案之后）；manual：学生点了重试。 */
export function prioritizeInsight(itemId: string, manual = false): void {
  const index = priority.findIndex(entry => entry.itemId === itemId);
  const entry = { itemId, manual: manual || (index >= 0 && priority[index]!.manual) };
  if (index >= 0) priority.splice(index, 1);
  priority.unshift(entry);
  requested.add(itemId);
  unavailableUntil.delete(itemId);
  if (queue?.timer) setImmediate(() => { void drainInsightQueue(); });
}

/** 当前内容的解答状态；不调用模型。 */
export function insightState(itemId: string): InsightState {
  const basis = basisOf(itemId);
  return basis ? stateFor(itemId, basis) : { state: 'unavailable' };
}

/** 打开详情页：还没有就排到最前（不马上调用模型）；retry：失败后学生点了重试。 */
export function requestInsight(itemId: string, options: { retry?: boolean } = {}): InsightState {
  const basis = basisOf(itemId);
  if (!basis) return { state: 'unavailable' };
  const current = stateFor(itemId, basis);
  if (current.state === 'ready' || current.state === 'generating') return current;
  // 排着（含失败后等自动再试）：记下来，录入再早的题也会再试（进程重启后靠这次打开补回来）。
  if (current.state === 'queued') { requested.add(itemId); return current; }
  if (current.state === 'failed' && (!options.retry || current.rateLimited)) return current;
  if (rateLimited(itemId)) return { state: 'failed', rateLimited: true };
  prioritizeInsight(itemId, options.retry === true);
  return { state: 'queued' };
}

/** 测试用：清掉进程内的排队状态（同一测试文件里的用例共用这个模块）。 */
export function resetInsightQueueForTest(): void {
  priority.length = 0;
  requested.clear();
  unavailableUntil.clear();
  scanCursor = 0;
  scanPausedUntil = 0;
}

/** 正在跑一件后台任务：worker 不因空闲退出。 */
export function insightWorkPending(): boolean {
  return busyWith !== null;
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

// ---------- 拍照录入答案 ----------

export function listAnswerPhotos(itemId: string): AnswerPhotoRecord[] {
  return (getDb().prepare('SELECT id, status, text, created_at FROM item_answer_photo WHERE item_id = ? ORDER BY created_at').all(itemId) as Array<{ id: string; status: AnswerPhotoStatus; text: string | null; created_at: string }>)
    .map(row => ({ id: row.id, status: row.status, text: row.text, createdAt: row.created_at }));
}

/** 存一张答案照片（缩到长边 2048 的 JPEG），排队转写。超过每题上限或读不出图返回错误文字。 */
export async function addAnswerPhoto(itemId: string, bytes: Buffer): Promise<AnswerPhotoRecord | string> {
  if ((getDb().prepare('SELECT COUNT(*) AS n FROM item_answer_photo WHERE item_id = ?').get(itemId) as { n: number }).n >= ANSWER_PHOTO_LIMIT) return `每道题最多录 ${ANSWER_PHOTO_LIMIT} 张答案照片，先删掉一张。`;
  let image: Buffer;
  try {
    image = await withProcessImage(() => sharp(bytes, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer());
  } catch { return '这张照片读不出来，换一张试试。'; }
  const id = newId('ans'), at = now();
  getDb().prepare("INSERT INTO item_answer_photo (id, item_id, image, status, created_at, updated_at) VALUES (?,?,?,'reading',?,?)").run(id, itemId, image, at, at);
  audit('item_answer_photo_added', 'item', itemId);
  if (queue?.timer) setImmediate(() => { void drainInsightQueue(); });
  return { id, status: 'reading', text: null, createdAt: at };
}

export function answerPhotoImage(itemId: string, photoId: string): Buffer | null {
  const row = getDb().prepare('SELECT image FROM item_answer_photo WHERE id = ? AND item_id = ?').get(photoId, itemId) as { image: Uint8Array } | undefined;
  return row ? Buffer.from(row.image) : null;
}

/** 学生改转写文字（没找到 / 转写失败时也可以自己填）。返回 null 表示没有这张照片或文字不合法。 */
export function editAnswerPhoto(itemId: string, photoId: string, text: unknown): AnswerPhotoRecord | null {
  if (typeof text !== 'string' || !text.trim() || text.length > ANSWER_TEXT_MAX_CHARS) return null;
  const db = getDb();
  if (!db.prepare("UPDATE item_answer_photo SET status = 'done', text = ?, error = NULL, updated_at = ? WHERE id = ? AND item_id = ?").run(text.trim(), now(), photoId, itemId).changes) return null;
  audit('item_answer_photo_edited', 'item', itemId);
  prioritizeInsight(itemId);
  return listAnswerPhotos(itemId).find(photo => photo.id === photoId) ?? null;
}

/** 转写失败或没找到时重新转写一次。 */
export function retryAnswerPhoto(itemId: string, photoId: string): boolean {
  const changed = getDb().prepare("UPDATE item_answer_photo SET status = 'reading', attempts = 0, error = NULL, updated_at = ? WHERE id = ? AND item_id = ? AND status IN ('failed','not_found')").run(now(), photoId, itemId).changes;
  if (changed && queue?.timer) setImmediate(() => { void drainInsightQueue(); });
  return changed > 0;
}

export function deleteAnswerPhoto(itemId: string, photoId: string): boolean {
  const removed = getDb().prepare('DELETE FROM item_answer_photo WHERE id = ? AND item_id = ?').run(photoId, itemId).changes > 0;
  if (removed) { audit('item_answer_photo_deleted', 'item', itemId); prioritizeInsight(itemId); }
  return removed;
}
