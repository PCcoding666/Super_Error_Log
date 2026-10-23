import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import path from 'node:path';
import { newId } from '../db/connection.js';
import { normalizePhoto } from '../media/images.js';
import type { AdmissionController } from '../mobile/admission.js';
import { acquireUploadAdmission, releaseUploadAdmission, type AdmissionReserve } from '../mobile/router.js';
import { MobileRequestError } from '../mobile/service.js';
import type { CaptureHints, JobTicket } from './contracts.js';
import { MaterialJobs } from './jobs.js';
import { MaterialStore } from './store.js';
import { originalSourcePath } from './media.js';

type Input = { captureId: string; uploadId: string; filename: string; bytes: Buffer; hints: CaptureHints };
/** duplicate: same bytes were already saved for this student; nothing new is stored and no AI job is started. */
type Saved = { assetId: string; job: JobTicket; created: boolean; duplicate?: boolean };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
async function syncDirectory(dir: string): Promise<void> { const handle = await fs.open(dir, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function write(filename: string, bytes: Buffer): Promise<void> {
  const handle = await fs.open(filename, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

export class MaterialUploads {
  readonly directory: string;
  private mutation: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: MaterialStore, private readonly jobs: MaterialJobs, private readonly admission: AdmissionController | null) {
    this.directory = path.join(jobs.dataDir, 'materials', createHash('sha256').update(store.studentId).digest('hex'));
  }
  /** Before accepting uploads, remove only staging directories; committed originals are never swept. */
  async initialize(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\.tmp-[0-9a-f-]{36}$/.test(entry.name)) await fs.rm(path.join(this.directory, entry.name), { recursive: true, force: true });
    }
  }
  hasUpload(uploadId: string): boolean {
    return !!this.store.db.prepare('SELECT 1 FROM material_asset WHERE owner_id=? AND upload_request_id=?').get(this.store.studentId, uploadId);
  }
  source(assetId: string): { originalPath: string; normalizedPath: string; sourceHash: string } {
    const row = this.store.db.prepare(`SELECT s.storage_path,s.content_hash FROM material_asset a JOIN source_asset s ON s.id=a.source_asset_id WHERE a.owner_id=? AND a.id=?`)
      .get(this.store.studentId, assetId) as { storage_path: string; content_hash: string } | undefined;
    if (!row) throw new MobileRequestError(404, 'not_found', '材料不存在。');
    return { normalizedPath: row.storage_path, originalPath: originalSourcePath(this.store, { assetId, sourceHash: row.content_hash }), sourceHash: row.content_hash };
  }
  save(input: Input, reservation?: AdmissionReserve): Promise<Saved> {
    const operation = this.mutation.then(() => this.saveLocked(input, reservation));
    this.mutation = operation.catch(() => undefined); return operation;
  }
  private async saveLocked(input: Input, reservation?: AdmissionReserve): Promise<Saved> {
    if (!UUID.test(input.uploadId)) throw new MobileRequestError(400, 'invalid_request', '上传请求键必须是 UUID。');
    if (!Buffer.isBuffer(input.bytes) || input.bytes.length === 0) throw new MobileRequestError(400, 'invalid_image', '照片无法读取，请重新选择。');
    if (input.bytes.length > 15 * 1024 * 1024) throw new MobileRequestError(413, 'payload_too_large', '照片超过 15 MiB 限制。');
    const hash = createHash('sha256').update(input.bytes).digest('hex');
    const fingerprint = createHash('sha256').update(canonical({ captureId: input.captureId, contentHash: hash, hints: input.hints })).digest('hex');
    const existing = this.store.db.prepare('SELECT id,upload_request_fingerprint FROM material_asset WHERE owner_id=? AND upload_request_id=?')
      .get(this.store.studentId, input.uploadId) as { id: string; upload_request_fingerprint: string | null } | undefined;
    if (existing) {
      if (existing.upload_request_fingerprint === null) throw new MobileRequestError(409, 'upload_identity_unavailable', '这张照片已保留在服务器，但旧上传信息无法核对。请先查看已经保存的材料，再删除这条待传记录；不用重新拍照。');
      if (existing.upload_request_fingerprint !== fingerprint) throw new MobileRequestError(409, 'idempotency_conflict', '这个上传请求已保存其他内容，请使用新的上传请求。');
      const job = this.store.db.prepare("SELECT id,kind,state FROM material_job WHERE owner_id=? AND asset_id=? AND kind='extract' AND request_id=?").get(this.store.studentId, existing.id, input.uploadId) as JobTicket | undefined;
      if (!job) throw new MobileRequestError(503, 'storage_unavailable', '材料任务暂时无法读取。');
      return { assetId: existing.id, job, created: false };
    }
    this.validateContext(input);
    // P1-1: the same student sending byte-identical photo again (re-upload, unsure it went through)
    // reuses the saved photo and its extraction; it never stores a second copy or calls the AI again.
    // An explicit supplement (this photo is the work for question/attempt X) stays a separate material.
    const duplicate = input.hints.questionId || input.hints.attemptId ? null : this.findDuplicate(hash, canonical(input.hints));
    if (duplicate) return duplicate;
    const owned = !reservation; const reserve = reservation ?? { slot: false, capacity: false, handoff: false };
    let staging: string | undefined; let committedDirectory: string | undefined;
    try {
      if (owned && this.admission) {
        const rejected = await acquireUploadAdmission(this.admission, reserve);
        if (rejected) throw new MobileRequestError(rejected.status, rejected.code, rejected.message);
      }
      let normalized: Buffer;
      try {
        const decode = async () => {
          const jpeg = await normalizePhoto(input.bytes);
          return sharp(jpeg).resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
        };
        normalized = this.admission ? await this.admission.withImage(decode) : await decode();
      }
      catch { throw new MobileRequestError(400, 'invalid_image', '照片无法读取、已损坏或超过像素限制，请补拍。'); }
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const finalDirectory = path.join(this.directory, hash);
      try { await fs.access(path.join(finalDirectory, 'original')); await fs.access(path.join(finalDirectory, 'normalized.jpg')); }
      catch {
        staging = path.join(this.directory, `.tmp-${randomUUID()}`); await fs.mkdir(staging, { mode: 0o700 });
        await write(path.join(staging, 'original'), input.bytes); await write(path.join(staging, 'normalized.jpg'), normalized); await syncDirectory(staging);
        await fs.rename(staging, finalDirectory); staging = undefined; committedDirectory = finalDirectory; await syncDirectory(this.directory);
      }
      const assetId = newId('mas'); const sourceId = newId('ast');
      const job = this.jobs.enqueue('extract', assetId, input.uploadId, hash, { reservation: reserve, persist: () => {
        const capture = this.store.db.prepare('SELECT source_batch_id FROM material_capture WHERE owner_id=? AND id=?').get(this.store.studentId, input.captureId) as { source_batch_id: string | null };
        const batchId = capture.source_batch_id ?? newId('bat');
        if (!capture.source_batch_id) {
          this.store.db.prepare('INSERT INTO source_batch(id,student_id,status,created_at) VALUES (?,?,?,?)').run(batchId, this.store.studentId, 'saved', new Date().toISOString());
          this.store.db.prepare('UPDATE material_capture SET source_batch_id=? WHERE owner_id=? AND id=?').run(batchId, this.store.studentId, input.captureId);
        }
        this.store.db.prepare('INSERT INTO source_asset(id,batch_id,filename,mime,size,content_hash,status,storage_path,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(sourceId, batchId, input.filename, 'image/jpeg', input.bytes.length, hash, 'saved', path.join(finalDirectory, 'normalized.jpg'), new Date().toISOString());
        this.store.db.prepare('INSERT INTO material_asset(id,owner_id,capture_id,source_asset_id,document_id,upload_request_id,hints_json,upload_request_fingerprint) VALUES (?,?,?,?,?,?,?,?)')
          .run(assetId, this.store.studentId, input.captureId, sourceId, input.hints.documentId ?? null, input.uploadId, canonical(input.hints), fingerprint);
        this.store.db.prepare('UPDATE source_batch SET total_files=total_files+1 WHERE id=? AND student_id=?').run(batchId, this.store.studentId);
      } });
      return { assetId, job, created: true };
    } catch (error) {
      if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (committedDirectory) {
        const referenced = this.store.db.prepare('SELECT 1 FROM source_asset WHERE storage_path=?').get(path.join(committedDirectory, 'normalized.jpg'));
        if (!referenced) await fs.rm(committedDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      if (error instanceof MobileRequestError) throw error;
      throw new MobileRequestError(503, 'storage_unavailable', '保存未完成，请稍后重新上传。');
    } finally { if (owned && this.admission) releaseUploadAdmission(this.admission, reserve); }
  }
  /** Only an equivalent upload is a duplicate: different role/marking/label/document hints are new information and stay a separate material. */
  private findDuplicate(hash: string, hints: string): Saved | null {
    const rows = this.store.db.prepare(`SELECT a.id,a.hints_json FROM material_asset a JOIN source_asset s ON s.id=a.source_asset_id
      WHERE a.owner_id=? AND s.content_hash=? ORDER BY a.rowid`).all(this.store.studentId, hash) as { id: string; hints_json: string }[];
    for (const row of rows) {
      let current: string; try { current = canonical(JSON.parse(row.hints_json)); } catch { continue; }
      if (current !== hints) continue;
      const job = this.store.db.prepare("SELECT id,kind,state FROM material_job WHERE owner_id=? AND asset_id=? AND kind='extract' ORDER BY rowid DESC LIMIT 1")
        .get(this.store.studentId, row.id) as JobTicket | undefined;
      if (job) return { assetId: row.id, job, created: false, duplicate: true };
    }
    return null;
  }
  private validateContext(input: Input): void {
    if (!this.store.db.prepare('SELECT 1 FROM material_capture WHERE owner_id=? AND id=?').get(this.store.studentId, input.captureId)) throw new MobileRequestError(404, 'not_found', '拍摄批次不存在。');
    for (const [value, table] of [[input.hints.documentId, 'material_document'], [input.hints.questionId, 'material_question']] as const) {
      if (value && !this.store.db.prepare(`SELECT 1 FROM ${table} WHERE owner_id=? AND id=?`).get(this.store.studentId, value)) throw new MobileRequestError(404, 'not_found', '关联材料不存在。');
    }
    if (input.hints.attemptId && !this.store.db.prepare('SELECT 1 FROM material_attempt WHERE owner_id=? AND id=? AND question_id=?').get(this.store.studentId, input.hints.attemptId, input.hints.questionId ?? '')) throw new MobileRequestError(404, 'not_found', '作答不存在。');
  }
}
