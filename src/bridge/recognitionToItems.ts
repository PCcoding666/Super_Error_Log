import { backfillLegacyMaterials } from '../materials/legacy.js';
import { questionExcerpt } from '../text/stemBlocks.js';
/**
 * v2.0 T3 桥：v2 上传的识别任务 → 错题记录。
 * 只做登记与映射：不复制图片（storage_path 指向手机任务目录里的规范化原图，裁图现算），不调用模型。
 * 整个任务的写入放在一个事务里；任何一步失败整体回滚并记录 bridge_error（fail-closed）。
 */
import { readItemCategory } from '../classification/itemCategories.js';
import fs from 'node:fs';
import path from 'node:path';
import { validateEvidence } from '../ai/evidence.js';
import { getDb, newId, now } from '../db/connection.js';
import { assignShortIds } from '../services/batchService.js';
import { audit } from '../services/eventLog.js';
import { ensureStudentProfile } from '../services/studentService.js';
import type { RecognitionQuestion, StoredRecognitionJob } from '../mobile/contracts.js';

const TERMINAL_STATUS = new Set(['completed', 'partial', 'failed']);
const BRIDGABLE_STATUS = new Set(['ready', 'needs_check', 'confirmed']);
const BRIDGABLE_SELECTION = new Set(['marked_wrong', 'corrected']);

/** T4 上传接口登记 v2 照片；重复登记幂等。未登记的任务永不进入学习记录。 */
export function registerV2Photo(jobId: string): void {
  const student = ensureStudentProfile();
  getDb()
    .prepare('INSERT OR IGNORE INTO v2_photo (job_id, student_id, registered_at) VALUES (?,?,?)')
    .run(jobId, student.id, now());
}

function loadJob(mobileDataDir: string, jobId: string): StoredRecognitionJob | null {
  try {
    const raw = fs.readFileSync(path.join(mobileDataDir, 'jobs', jobId, 'job.json'), 'utf8');
    const job = JSON.parse(raw) as StoredRecognitionJob;
    if (job.id !== jobId || !Array.isArray(job.questions) || typeof job.sourceHash !== 'string') return null;
    return job;
  } catch {
    return null;
  }
}

function recordBridgeError(jobId: string, message: string): void {
  getDb().prepare('UPDATE v2_photo SET bridge_error = ? WHERE job_id = ?').run(message, jobId);
}

function bridgable(question: RecognitionQuestion): boolean {
  // v2.1a：学生勾入的题（selectedByStudent）与有批改痕迹的题一样成为错题；unselected 的题永不建题。
  return (BRIDGABLE_SELECTION.has(question.selectionEvidence) || question.selectedByStudent === true)
    && question.evidence !== null
    && BRIDGABLE_STATUS.has(question.status);
}

const badgeOf = (question: RecognitionQuestion): string =>
  (question.status === 'needs_check' || question.manualRelease === true ? 'low' : 'ok');

/** 把单个已登记任务的当前 revision 桥接为错题记录；不满足条件时不做任何事。 */
export function bridgeJob(jobId: string, mobileDataDir: string): void {
  const db = getDb();
  const photo = db.prepare('SELECT * FROM v2_photo WHERE job_id = ?').get(jobId) as
    { job_id: string; student_id: string; registered_at: string; bridged_revision: number | null; bridge_error: string | null;
      batch_id: string | null; asset_id: string | null; source_hash: string | null } | undefined;
  if (!photo) return;
  const job = loadJob(mobileDataDir, jobId);
  if (!job) {
    recordBridgeError(jobId, 'job_unreadable');
    return;
  }
  // 读到任务后先落 source_hash，供 SQL 判重（先登记的赢，不依赖对方是否已桥接）。
  if (photo.source_hash !== job.sourceHash) {
    db.prepare('UPDATE v2_photo SET source_hash = ? WHERE job_id = ?').run(job.sourceHash, jobId);
  }
  if (!TERMINAL_STATUS.has(job.status)) return;
  if (photo.bridged_revision === job.revision) return;

  // 同一张照片重复上传：已有同哈希登记成功桥接（bridged_revision 已写且无错误）则一律判重复；
  // 否则按"登记更早（同时刻则 job_id 更小）者优先"判断。不变量：同一哈希最多一份登记建题。
  const duplicate = db.prepare(
    `SELECT job_id FROM v2_photo
     WHERE job_id != ? AND source_hash = ? AND (
       (bridged_revision IS NOT NULL AND bridge_error IS NULL)
       OR registered_at < ? OR (registered_at = ? AND job_id < ?)
     ) ORDER BY registered_at, job_id LIMIT 1`,
  ).get(jobId, job.sourceHash, photo.registered_at, photo.registered_at, jobId) as { job_id: string } | undefined;
  if (duplicate) {
    recordBridgeError(jobId, `duplicate_source:${duplicate.job_id}`);
    return;
  }

  const media = job.media?.[job.sourceMediaId];
  if (!media) {
    recordBridgeError(jobId, 'source_media_missing');
    return;
  }
  const storagePath = path.join(path.resolve(mobileDataDir), 'jobs', jobId, 'media', media.filename);

  // 先分类：本次要新建的题与要更新的题；没有任何新建题时不创建批次与原图。
  const creates: Array<{ index: number; question: RecognitionQuestion }> = [];
  const updates: Array<{ itemId: string; question: RecognitionQuestion }> = [];
  for (const [index, question] of job.questions.entries()) {
    const link = db.prepare('SELECT * FROM mobile_item_link WHERE job_id = ? AND question_id = ?').get(jobId, question.id) as
      { item_id: string; question_revision: number } | undefined;
    if (link) {
      if (question.revision <= link.question_revision || !bridgable(question)) continue;
      const locked = db.prepare('SELECT 1 FROM error_diagnosis WHERE item_id = ? LIMIT 1').get(link.item_id)
        ?? db.prepare('SELECT 1 FROM review_packet_item WHERE item_id = ? LIMIT 1').get(link.item_id);
      if (locked) {
        // 已有反思或已进练习包：不动证据，记一笔日志。
        audit('bridge_item_update_skipped', 'item', link.item_id);
        continue;
      }
      updates.push({ itemId: link.item_id, question });
      continue;
    }
    if (!bridgable(question)) continue;
    creates.push({ index, question });
  }

  try {
    db.exec('BEGIN');
    let batchId = photo.batch_id;
    let assetId = photo.asset_id;
    if (creates.length > 0 && !batchId) {
      // 首次需要建题时才创建批次与原图，并写回 v2_photo；之后再桥接一律复用。
      const size = fs.statSync(storagePath).size;
      batchId = newId('bat');
      db.prepare("INSERT INTO source_batch (id, student_id, status, total_files, done_files, created_at) VALUES (?,?,'done',1,1,?)")
        .run(batchId, photo.student_id, now());
      assetId = newId('ast');
      db.prepare(
        "INSERT INTO source_asset (id, batch_id, filename, mime, size, content_hash, status, storage_path, created_at) VALUES (?,?,?,?,?,?,'done',?,?)",
      ).run(assetId, batchId, media.filename, 'image/jpeg', size, job.sourceHash, storagePath, now());
      db.prepare("INSERT INTO asset_origin (asset_id, mode) VALUES (?, 'bailian')").run(assetId);
      db.prepare('UPDATE v2_photo SET batch_id = ?, asset_id = ? WHERE job_id = ?').run(batchId, assetId, jobId);
    }

    for (const { itemId, question } of updates) {
      db.prepare('UPDATE evidence_record SET content_json = ?, auto_checks_json = ?, confidence_badge = ?, updated_at = ? WHERE item_id = ?')
        .run(JSON.stringify(validateEvidence(question.evidence)), JSON.stringify(question.verification ?? null), badgeOf(question), now(), itemId);
      db.prepare('UPDATE mobile_item_link SET question_revision = ? WHERE item_id = ?').run(question.revision, itemId);
    }

    for (const { index, question } of creates) {
      const content = validateEvidence(question.evidence);
      const itemId = newId('itm');
      db.prepare(
        `INSERT INTO error_item
         (id, student_id, batch_id, asset_id, item_index, subject, chapter, knowledge_tags, question_type,
          status, needs_correction, has_work_img, has_answer_img, has_teacher_note, text_excerpt, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?, 'ready_for_reflection', 0, ?,?,?,?,?,?)`,
      ).run(
        itemId, photo.student_id, batchId, assetId, index,
        content.subject, content.chapter, JSON.stringify(content.knowledgeTags), content.questionType,
        content.observations.some((o) => o.kind === 'student_work') ? 1 : 0,
        content.observations.some((o) => o.kind === 'reference_answer') ? 1 : 0,
        content.observations.some((o) => o.kind === 'teacher_note') ? 1 : 0,
        questionExcerpt(content.questionText), now(), now(),
      );
      db.prepare('INSERT INTO evidence_record (item_id, content_json, auto_checks_json, confidence_badge, updated_at) VALUES (?,?,?,?,?)')
        .run(itemId, JSON.stringify(content), JSON.stringify(question.verification ?? null), badgeOf(question), now());
      db.prepare('INSERT INTO mobile_item_link (item_id, job_id, question_id, question_revision, selected_by_student) VALUES (?,?,?,?,?)')
        .run(itemId, jobId, question.id, question.revision, question.selectedByStudent === true ? 1 : 0);
      readItemCategory(db, photo.student_id, itemId);
    }

    if (batchId) assignShortIds(batchId);
    db.prepare('UPDATE v2_photo SET bridged_revision = ?, bridge_error = NULL WHERE job_id = ?').run(job.revision, jobId);
    backfillLegacyMaterials(db);
    db.exec('COMMIT');
    audit('bridge_job_bridged', 'v2_photo', jobId);
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    recordBridgeError(jobId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** 启动与 /v2 读接口前调用：把尚未桥接到最新 revision 的登记任务逐个桥接，单个失败不影响其他。 */
export function bridgePending(mobileDataDir: string): void {
  const rows = getDb().prepare('SELECT job_id FROM v2_photo ORDER BY registered_at, job_id').all() as Array<{ job_id: string }>;
  for (const row of rows) {
    try {
      bridgeJob(row.job_id, mobileDataDir);
    } catch {
      // bridge_error 已由 bridgeJob 记录；继续处理其余任务。
    }
  }
}
