/**
 * v2.0 T4a：本周错题卡片（/v2/week）与"不是错题"删/恢复。
 * 只返回 v2 来源（有 mobile_item_link）的题；Web 原有题一律不出现。
 * 删/恢复不走 archiveItem（其规则是"不值得复习"，语义不同）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb, now } from '../db/connection.js';
import { isoWeekKey } from '../domain/scheduling.js';
import { bridgePending } from '../bridge/recognitionToItems.js';
import { getItem } from '../services/itemService.js';
import { audit } from '../services/eventLog.js';
import type { ItemStatus } from '../domain/types.js';

/** 题是否来自 v2 手机上传（有 mobile_item_link）。后续任务复用。 */
export function isV2Item(itemId: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM mobile_item_link WHERE item_id = ? LIMIT 1').get(itemId);
}

export interface V2WeekItem {
  id: string;
  shortId: string | null;
  subject: string | null;
  knowledgeTags: string[];
  questionExcerpt: string | null;
  badge: 'ok' | 'low';
  status: ItemStatus;
  cropUrl: string;
  jobId: string;
}

export interface V2WeekPhoto {
  jobId: string;
  registeredAt: string;
  recognition: 'processing' | 'done' | 'failed';
  bridged: boolean;
  bridgeError: string | null;
  itemCount: number;
  /** v2.1a：该任务当前 unselected（等学生勾选）的题数；任务读不到时为 0。 */
  unselectedCount: number;
}

export interface V2WeekResponse {
  week: string;
  photos: V2WeekPhoto[];
  items: V2WeekItem[];
  backlog: V2WeekItem[];
}

type PhotoRow = {
  job_id: string; registered_at: string; bridged_revision: number | null; bridge_error: string | null;
};

/** 识别状态读移动任务本身：终态 completed/partial 为 done，failed 为 failed，其余（含不可读）为 processing。 */
function recognitionOf(mobileDataDir: string, jobId: string): V2WeekPhoto['recognition'] {
  try {
    const raw = fs.readFileSync(path.join(mobileDataDir, 'jobs', jobId, 'job.json'), 'utf8');
    const status = (JSON.parse(raw) as { status?: unknown }).status;
    if (status === 'completed' || status === 'partial') return 'done';
    if (status === 'failed') return 'failed';
    return 'processing';
  } catch {
    return 'processing';
  }
}

/** 该任务当前 unselected 的题数；任务读不到时为 0。 */
function unselectedCountOf(mobileDataDir: string, jobId: string): number {
  try {
    const raw = fs.readFileSync(path.join(mobileDataDir, 'jobs', jobId, 'job.json'), 'utf8');
    const questions = (JSON.parse(raw) as { questions?: unknown }).questions;
    if (!Array.isArray(questions)) return 0;
    return questions.filter(question => (question as { status?: unknown }).status === 'unselected').length;
  } catch {
    return 0;
  }
}

const BACKLOG_STATUSES: readonly ItemStatus[] = ['ready_for_reflection', 'eligible_for_review', 'needs_recheck'];

/** 本周错题卡片。先懒桥接（单个失败不影响返回），再按登记的 ISO 周划分 items / backlog。 */
export function getWeek(mobileDataDir: string): V2WeekResponse {
  try {
    bridgePending(mobileDataDir);
  } catch {
    // 懒桥接整体失败不影响返回。
  }
  const db = getDb();
  const week = isoWeekKey(new Date());

  const photos = (db.prepare('SELECT job_id, registered_at, bridged_revision, bridge_error FROM v2_photo ORDER BY registered_at, job_id').all() as PhotoRow[])
    .filter(photo => isoWeekKey(new Date(photo.registered_at)) === week)
    .map(photo => ({
      jobId: photo.job_id,
      registeredAt: photo.registered_at,
      recognition: recognitionOf(mobileDataDir, photo.job_id),
      bridged: photo.bridged_revision !== null && photo.bridge_error === null,
      bridgeError: photo.bridge_error,
      itemCount: (db.prepare('SELECT COUNT(*) AS n FROM mobile_item_link WHERE job_id = ?').get(photo.job_id) as { n: number }).n,
      unselectedCount: unselectedCountOf(mobileDataDir, photo.job_id),
    }));

  type JoinedRow = {
    id: string; short_id: string | null; subject: string | null; knowledge_tags: string;
    text_excerpt: string | null; status: ItemStatus; archived_reason: string | null;
    job_id: string; registered_at: string; confidence_badge: string | null;
  };
  const rows = db.prepare(
    `SELECT ei.id, ei.short_id, ei.subject, ei.knowledge_tags, ei.text_excerpt, ei.status, ei.archived_reason,
            mil.job_id, vp.registered_at, er.confidence_badge
     FROM mobile_item_link mil
     JOIN error_item ei ON ei.id = mil.item_id
     JOIN v2_photo vp ON vp.job_id = mil.job_id
     LEFT JOIN evidence_record er ON er.item_id = ei.id
     ORDER BY vp.registered_at, ei.item_index, ei.id`,
  ).all() as JoinedRow[];

  const toCard = (row: JoinedRow): V2WeekItem => ({
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

  const items: V2WeekItem[] = [];
  const backlog: V2WeekItem[] = [];
  for (const row of rows) {
    const thisWeek = isoWeekKey(new Date(row.registered_at)) === week;
    if (thisWeek) {
      // 本周登记照片桥接出的题，未被标"不是错题"。
      if (row.status === 'archived_not_worth_review' && row.archived_reason === 'not_a_mistake') continue;
      items.push(toCard(row));
    } else if (BACKLOG_STATUSES.includes(row.status)) {
      backlog.push(toCard(row));
    }
  }
  return { week, photos, items, backlog };
}

export type V2ItemAction =
  | { ok: true; status: ItemStatus }
  | { ok: false; httpStatus: 404 | 409; message: string };

/** "不是错题"：仅 v2 来源、待反思/待安排、且不在未回传的练习包里。 */
export function discardV2Item(itemId: string): V2ItemAction {
  const db = getDb();
  const item = getItem(itemId);
  if (!item || !isV2Item(itemId)) return { ok: false, httpStatus: 404, message: '题目不存在或不属于手机上传。' };
  if (item.status !== 'ready_for_reflection' && item.status !== 'eligible_for_review') {
    return { ok: false, httpStatus: 409, message: '当前状态不能标记为"不是错题"。' };
  }
  const inOpenPacket = db.prepare(
    `SELECT 1 FROM review_packet_item rpi
     WHERE rpi.item_id = ?
       AND NOT EXISTS (SELECT 1 FROM review_attempt ra WHERE ra.packet_id = rpi.packet_id AND ra.item_id = rpi.item_id)
     LIMIT 1`,
  ).get(itemId);
  if (inOpenPacket) return { ok: false, httpStatus: 409, message: '该题已在未回传的练习包中，请先完成练习回传。' };
  db.prepare("UPDATE error_item SET status = 'archived_not_worth_review', archived_reason = 'not_a_mistake', updated_at = ? WHERE id = ?")
    .run(now(), itemId);
  audit('v2_item_discarded', 'item', itemId);
  return { ok: true, status: 'archived_not_worth_review' };
}

/** 恢复：仅对 archived_reason = 'not_a_mistake' 的 v2 题；有反思回 eligible_for_review，否则回 ready_for_reflection。 */
export function restoreV2Item(itemId: string): V2ItemAction {
  const db = getDb();
  const item = getItem(itemId);
  if (!item || !isV2Item(itemId)) return { ok: false, httpStatus: 404, message: '题目不存在或不属于手机上传。' };
  if (item.status !== 'archived_not_worth_review' || item.archived_reason !== 'not_a_mistake') {
    return { ok: false, httpStatus: 409, message: '该题不在"不是错题"状态，无法恢复。' };
  }
  const hasReflection = !!db.prepare('SELECT 1 FROM error_diagnosis WHERE item_id = ? LIMIT 1').get(itemId);
  const to: ItemStatus = hasReflection ? 'eligible_for_review' : 'ready_for_reflection';
  db.prepare('UPDATE error_item SET status = ?, archived_reason = NULL, updated_at = ? WHERE id = ?').run(to, now(), itemId);
  audit('v2_item_restored', 'item', itemId);
  return { ok: true, status: to };
}
