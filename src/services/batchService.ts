import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizePhoto, isHeif } from '../media/images.js';
import { getAiProvider } from '../ai/index.js';
import { AiError } from '../ai/errors.js';
import { FIELD_CONFIDENCE_THRESHOLD, LOW_CONFIDENCE_THRESHOLD } from '../ai/provider.js';
import { config, uploadsDir } from '../config.js';
import { getDb, newId, now } from '../db/connection.js';
import type { AssetStatus, BatchStatus, Subject } from '../domain/types.js';
import { audit, recordAiRun } from './eventLog.js';
import { createEvidenceRecord } from './evidenceService.js';
import type { ExtractedItem } from '../ai/provider.js';
import { isDemoAsset } from './assetOrigin.js';

export interface UploadFile {
  filename: string;
  mime: string;
  buffer: Buffer;
}

const SUBJECT_PREFIX: Record<string, string> = { 数学: 'M', 物理: 'P', 化学: 'C' };

interface AssetRow {
  id: string;
  batchId: string;
  filename: string;
  mime: string;
  size: number;
  contentHash: string;
  status: AssetStatus;
  error: string | null;
  storagePath: string;
}

/** 归一化图片：按 EXIF 方向转正、去除元数据（隐私），输出固定格式 */
export async function normalizeImage(buffer: Buffer): Promise<Buffer> {
  return normalizePhoto(buffer);
}

export async function createBatch(studentId: string, files: UploadFile[]): Promise<{ batchId: string }> {
  const db = getDb();
  const batchId = newId('bat');
  db.prepare(
    'INSERT INTO source_batch (id, student_id, status, total_files, created_at) VALUES (?,?,?,?,?)',
  ).run(batchId, studentId, 'processing', files.length, now());

  const seenHashes = new Set<string>();
  const existing = db
    .prepare(
      `SELECT DISTINCT content_hash FROM source_asset sa
       JOIN source_batch sb ON sb.id = sa.batch_id
       WHERE sb.student_id = ? AND sa.status NOT IN ('unsupported','too_large','empty','duplicate')`,
    )
    .all(studentId) as Array<{ content_hash: string }>;
  const knownHashes = new Set(existing.map((r) => r.content_hash));

  for (const f of files) {
    const row: AssetRow = {
      id: newId('ast'),
      batchId,
      filename: f.filename,
      mime: f.mime,
      size: f.buffer.length,
      contentHash: '-',
      status: 'queued',
      error: null,
      storagePath: '',
    };

    if (f.buffer.length === 0) {
      insertAsset(db, { ...row, status: 'empty', error: '空文件' });
      continue;
    }
    if (f.buffer.length > config.maxUploadBytes) {
      insertAsset(db, { ...row, status: 'too_large', error: '文件超过 15MB 限制' });
      continue;
    }
    let bytes = f.buffer;
    const incomingMime = isHeif(f.buffer) ? 'image/heic' : f.mime;
    let ext = config.allowedMime.get(incomingMime);
    let finalMime = incomingMime;
    if (!ext) {
      insertAsset(db, { ...row, status: 'unsupported', error: `不支持的格式 ${f.mime}` });
      continue;
    }
    if (incomingMime.startsWith('image/')) {
      try {
        bytes = await normalizeImage(f.buffer);
        ext = '.jpg';
        finalMime = 'image/jpeg';
      } catch {
        insertAsset(db, { ...row, status: 'failed', error: '图片损坏或无法解析' });
        continue;
      }
    }

    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (seenHashes.has(hash) || knownHashes.has(hash)) {
      insertAsset(db, { ...row, mime: finalMime, contentHash: hash, status: 'duplicate', error: '重复文件，已跳过' });
      continue;
    }
    seenHashes.add(hash);

    const storagePath = path.join(uploadsDir(), `${hash}${ext}`);
    fs.writeFileSync(storagePath, bytes);
    insertAsset(db, { ...row, mime: finalMime, size: bytes.length, contentHash: hash, storagePath });
  }

  audit('batch_created', 'batch', batchId);
  return { batchId };
}

function insertAsset(db: ReturnType<typeof getDb>, row: AssetRow): void {
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO source_asset (id, batch_id, filename, mime, size, content_hash, status, error, storage_path, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(row.id, row.batchId, row.filename, row.mime, row.size, row.contentHash, row.status, row.error, row.storagePath, now());
    db.prepare('INSERT INTO asset_origin (asset_id, mode) VALUES (?, ?)').run(row.id, config.aiMode);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const MAX_RETRY: Record<string, number> = { timeout: 2, provider_error: 2, rate_limited: 2, invalid_json: 1, unsupported: 0 };

const processingBatches = new Set<string>();

export async function processBatch(batchId: string): Promise<void> {
  if (processingBatches.has(batchId)) return;
  processingBatches.add(batchId);
  try {
    await processBatchInner(batchId);
  } finally {
    processingBatches.delete(batchId);
  }
}

async function processBatchInner(batchId: string): Promise<void> {
  const db = getDb();
  const provider = getAiProvider();
  const assets = db
    .prepare("SELECT * FROM source_asset WHERE batch_id = ? AND status = 'queued'")
    .all(batchId) as Array<{
    id: string; filename: string; mime: string; content_hash: string; storage_path: string;
  }>;

  for (const asset of assets) {
    db.prepare("UPDATE source_asset SET status = 'processing' WHERE id = ?").run(asset.id);
    let attempt = 0;
    let lastError: AiError | null = null;
    let extracted = false;

    while (attempt <= 2 && !extracted) {
      const started = Date.now();
      try {
        const result = await provider.extractItems({
          assetId: asset.id,
          filename: asset.filename,
          mime: asset.mime,
          storagePath: asset.storage_path,
          contentHash: asset.content_hash,
        });
        persistItems(asset.id, batchId, result.items);
        recordAiRun({ provider: provider.name, operation: 'extract', assetId: asset.id, status: 'ok', latencyMs: Date.now() - started });
        db.prepare("UPDATE source_asset SET status = 'done' WHERE id = ?").run(asset.id);
        extracted = true;
      } catch (e) {
        const err = e instanceof AiError ? e : new AiError('provider_error', String(e));
        lastError = err;
        recordAiRun({
          provider: provider.name, operation: 'extract', assetId: asset.id,
          status: err.kind === 'timeout' || err.kind === 'invalid_json' ? err.kind : 'error',
          latencyMs: Date.now() - started, error: err.message,
        });
        attempt += 1;
        if (attempt > (MAX_RETRY[err.kind] ?? 0)) break;
      }
    }

    if (!extracted) {
      db.prepare("UPDATE source_asset SET status = 'failed', error = ? WHERE id = ?")
        .run(lastError ? `${lastError.kind}: ${lastError.message}` : '未知错误', asset.id);
      audit('batch_file_failed', 'asset', asset.id);
    }
  }
  finalizeBatch(batchId);
}

function persistItems(assetId: string, batchId: string, items: ExtractedItem[]): void {
  const db = getDb();
  const batch = db.prepare('SELECT student_id FROM source_batch WHERE id = ?').get(batchId) as { student_id: string };
  db.exec('BEGIN');
  try {
    for (const it of items) {
      const existing = db
        .prepare('SELECT id FROM error_item WHERE asset_id = ? AND item_index = ?')
        .get(assetId, it.itemIndex) as { id: string } | undefined;
      if (existing) {
        const hasEvidence = db.prepare('SELECT 1 FROM evidence_record WHERE item_id = ?').get(existing.id);
        if (hasEvidence) continue;
        if (it.evidence) {
          createEvidenceRecord(existing.id, it.evidence, it.evidenceRuns ?? [], it.cropAudit);
          continue;
        }
        if (!isDemoAsset(assetId)) {
          throw new AiError('invalid_json', '真实资产已有条目但缺少 evidence');
        }
        continue;
      }

      const lowOverall = it.confidence < LOW_CONFIDENCE_THRESHOLD;
      const lowField = Object.values(it.fieldConfidence).some((v) => v < FIELD_CONFIDENCE_THRESHOLD);
      const needsCorrection = !!it.evidence || lowOverall || lowField || !it.subject || it.knowledgeTags.length === 0;
      const status = needsCorrection ? 'needs_review' : 'ready_for_reflection';
      const suggestion = JSON.stringify({
        subject: it.subject ?? null,
        knowledgeTags: it.knowledgeTags,
        questionType: it.questionType ?? null,
        fieldConfidence: it.fieldConfidence,
        selectionEvidence: it.selectionEvidence ?? null,
      });
      const itemId = newId('itm');
      const hasWorkImage = it.evidence
        ? it.evidence.observations.some((observation) => observation.kind === 'student_work')
        : isDemoAsset(assetId);
      db.prepare(
        `INSERT INTO error_item
         (id, student_id, batch_id, asset_id, item_index, subject, chapter, knowledge_tags, question_type,
          status, confidence, needs_correction, has_teacher_note, has_answer_img, has_work_img,
          text_excerpt, ai_suggestion, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        itemId, batch.student_id, batchId, assetId, it.itemIndex,
        it.subject ?? null, it.chapter ?? null, JSON.stringify(it.knowledgeTags), it.questionType ?? null,
        status, it.confidence, needsCorrection ? 1 : 0, it.hasTeacherNote ? 1 : 0, it.hasAnswer ? 1 : 0,
        hasWorkImage ? 1 : 0, it.textExcerpt, suggestion, now(), now(),
      );
      if (it.evidence) createEvidenceRecord(itemId, it.evidence, it.evidenceRuns ?? [], it.cropAudit);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 为批次中尚无 short_id 的条目分配短 ID（按学科前缀 + 学生内序号） */
export function assignShortIds(batchId: string): void {
  const db = getDb();
  const batch = db.prepare('SELECT student_id FROM source_batch WHERE id = ?').get(batchId) as { student_id: string };
  const items = db
    .prepare("SELECT id, subject FROM error_item WHERE batch_id = ? AND short_id IS NULL ORDER BY created_at, id")
    .all(batchId) as Array<{ id: string; subject: string | null }>;
  for (const item of items) {
    const prefix = SUBJECT_PREFIX[item.subject ?? ''] ?? 'X';
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM error_item WHERE student_id = ? AND short_id IS NOT NULL")
      .get(batch.student_id) as { n: number };
    const shortId = `${prefix}-${String(row.n + 1).padStart(2, '0')}`;
    db.prepare('UPDATE error_item SET short_id = ?, updated_at = ? WHERE id = ?').run(shortId, now(), item.id);
  }
}

export function finalizeBatch(batchId: string): void {
  const db = getDb();
  assignShortIds(batchId);
  const stats = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN status IN ('failed', 'empty', 'unsupported', 'too_large') THEN 1 ELSE 0 END) AS failed
       FROM source_asset WHERE batch_id = ?`,
    )
    .get(batchId) as { total: number; done: number; failed: number };
  const needsReview = db
    .prepare("SELECT COUNT(*) AS n FROM error_item WHERE batch_id = ? AND status = 'needs_review'")
    .get(batchId) as { n: number };

  let status: BatchStatus = 'done';
  if (stats.done === 0 && stats.failed > 0) status = 'failed';
  else if (stats.failed > 0) status = 'partial';
  else if (needsReview.n > 0) status = 'needs_attention';

  db.prepare(
    'UPDATE source_batch SET status = ?, done_files = ?, failed_files = ? WHERE id = ?',
  ).run(status, stats.done, stats.failed, batchId);
}

export function retryFailedAssets(batchId: string): number {
  const db = getDb();
  const r = db
    .prepare("UPDATE source_asset SET status = 'queued', error = NULL WHERE batch_id = ? AND status = 'failed'")
    .run(batchId);
  if (r.changes > 0) {
    db.prepare("UPDATE source_batch SET status = 'processing' WHERE id = ?").run(batchId);
    audit('batch_retried', 'batch', batchId);
  }
  return Number(r.changes);
}
