import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getDb, now } from '../db/connection.js';
import { assertPrintable, validateEvidence, type Evidence, type Diagnosis, type Coaching } from '../ai/evidence.js';
import type { StageResult, StageRun } from '../ai/chatClient.js';
import type { ExtractInput } from '../ai/provider.js';
import { StagedProvider } from '../ai/stagedProvider.js';
import { getAiProvider } from '../ai/index.js';
import { cropPhoto } from '../media/images.js';
import { audit } from './eventLog.js';
import { assertCropAudit, CropAuditor, evidenceFingerprint, sha256, cropCheckHash, type CropAuditReport } from '../ai/cropAuditor.js';
import { humanResolution } from '../ai/cropResolution.js';
import { CROP_AUDIT_VERSION } from '../ai/cropAudit.js';

export interface EvidenceRecord { content: Evidence; revision: number; verified: boolean; provenance: StageRun[]; diagnosis: StageResult<Diagnosis> | null; coaching: StageResult<Coaching> | null; cropAudit: CropAuditReport | null }
export function getEvidence(itemId: string): EvidenceRecord | null {
  const row = getDb().prepare('SELECT * FROM evidence_record WHERE item_id=?').get(itemId) as { content_json: string; revision: number; verified: number; provenance_json: string; diagnosis_json: string | null; coaching_json: string | null; crop_audit_json: string | null } | undefined;
  return row ? { content: validateEvidence(JSON.parse(row.content_json)), revision: row.revision, verified: row.verified === 1, provenance: JSON.parse(row.provenance_json), diagnosis: row.diagnosis_json ? JSON.parse(row.diagnosis_json) : null, coaching: row.coaching_json ? JSON.parse(row.coaching_json) : null, cropAudit: row.crop_audit_json ? JSON.parse(row.crop_audit_json) : null } : null;
}

export function createEvidenceRecord(itemId: string, content: Evidence, runs: StageRun[], cropAudit?: CropAuditReport): void {
  getDb().prepare('INSERT INTO evidence_record(item_id,content_json,provenance_json,crop_audit_json,updated_at) VALUES(?,?,?,?,?)')
    .run(itemId, JSON.stringify(validateEvidence(content)), JSON.stringify(runs), cropAudit ? JSON.stringify(cropAudit) : null, now());
}

export function evidenceSource(itemId: string): ExtractInput {
  const row = getDb().prepare(`SELECT sa.* FROM source_asset sa JOIN error_item ei ON ei.asset_id=sa.id WHERE ei.id=?`).get(itemId) as { id: string; filename: string; mime: string; content_hash: string; storage_path: string } | undefined;
  if (!row) throw new Error('题目不存在');
  return { assetId: row.id, filename: row.filename, mime: row.mime, contentHash: row.content_hash, storagePath: row.storage_path };
}

export async function getEvidenceCrop(itemId: string, regionId: string): Promise<Buffer> {
  const record = getEvidence(itemId); const region = record?.content.regions.find(r => r.id === regionId);
  if (!region) throw new Error('图示区域不存在');
  return cropPhoto(fs.readFileSync(evidenceSource(itemId).storagePath), region.box);
}

export async function getQuestionCrop(itemId: string): Promise<Buffer> {
  const record = getEvidence(itemId); if (!record) throw new Error('题目不存在');
  return cropPhoto(fs.readFileSync(evidenceSource(itemId).storagePath), record.content.questionRegion);
}

export function assertEvidenceReady(itemId: string, record = getEvidence(itemId)): void {
  if (!record) throw new Error('没有真实题目证据');
  assertPrintable(record.content, record.verified);
  assertCropAudit(record.content, record.cropAudit, sha256(fs.readFileSync(evidenceSource(itemId).storagePath)));
}

const checkingCrops = new Set<string>();
export function resolveEvidenceCrop(itemId: string, expectedRevision: number, targetId: string, input: unknown): void {
  if (checkingCrops.has(itemId)) throw new Error('裁图检查正在进行，请完成后再人工复核');
  assertEditable(itemId);
  const record = getEvidence(itemId); const report = record?.cropAudit;
  if (!record || record.revision !== expectedRevision || !report) throw new Error('证据或检查结果已更新，请重新加载');
  if (report.policyVersion !== CROP_AUDIT_VERSION || report.evidenceHash !== evidenceFingerprint(record.content)
    || report.sourceHash !== sha256(fs.readFileSync(evidenceSource(itemId).storagePath))) throw new Error('检查已过期，请先对当前证据重新检查');
  const target = report.targets.find(t => t.id === targetId); if (!target) throw new Error('裁图目标不存在');
  const resolution = humanResolution(target, report, cropCheckHash(target), input);
  report.humanResolutions = [...(report.humanResolutions ?? []).filter(h => h.targetId !== targetId), resolution];
  const db = getDb(); db.exec('BEGIN');
  try {
    db.prepare('UPDATE evidence_record SET crop_audit_json=?,verified=0,diagnosis_json=NULL,coaching_json=NULL,updated_at=? WHERE item_id=?').run(JSON.stringify(report), now(), itemId);
    db.prepare("UPDATE error_item SET status='needs_review',needs_correction=1,updated_at=? WHERE id=?").run(now(), itemId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  audit('evidence_crop_human_resolution', 'item', itemId);
}
export async function checkEvidenceCrops(itemId: string, expectedRevision: number): Promise<void> {
  if (checkingCrops.has(itemId)) throw new Error('裁图检查正在进行，请勿重复提交');
  const record = getEvidence(itemId); if (!record) throw new Error('没有可检查证据');
  assertEditable(itemId);
  if (record.revision !== expectedRevision) throw new Error('证据已更新，请重新加载');
  const provider = getAiProvider();
  if (!(provider instanceof StagedProvider)) throw new Error('请配置真实多模态模型，演示模式不会伪造裁图检查');
  checkingCrops.add(itemId);
  try {
    const source = evidenceSource(itemId);
    const report = await new CropAuditor(provider.client).check(fs.readFileSync(source.storagePath), record.content, record.cropAudit);
    assertEditable(itemId);
    if (getEvidence(itemId)?.revision !== record.revision || sha256(fs.readFileSync(source.storagePath)) !== report.sourceHash) throw new Error('检查期间证据或原图已更新，旧结果不保存');
    const db = getDb(); db.exec('BEGIN');
    try {
      db.prepare('UPDATE evidence_record SET crop_audit_json=?,verified=0,diagnosis_json=NULL,coaching_json=NULL,updated_at=? WHERE item_id=?')
        .run(JSON.stringify(report), now(), itemId);
      db.prepare("UPDATE error_item SET status='needs_review',needs_correction=1,updated_at=? WHERE id=?").run(now(), itemId);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    audit('evidence_crops_checked', 'item', itemId);
  } finally { checkingCrops.delete(itemId); }
}

export function diagramPath(itemId: string, revision: number, regionIndex: number): string {
  // IDs originate in the database; callers never use untrusted region IDs as paths.
  if (!/^itm_[a-f0-9]+$/.test(itemId) || !Number.isSafeInteger(revision) || !Number.isSafeInteger(regionIndex)) throw new Error('题目缓存标识无效');
  return path.join(config.dataDir, 'evidence', `${itemId}-${revision}-${regionIndex}.jpg`);
}

function assertEditable(itemId: string): void {
  if (getDb().prepare('SELECT 1 FROM review_packet_item WHERE item_id=? LIMIT 1').get(itemId)) throw new Error('该题已进入复习包，不能原地修改证据');
}

/** Excluding a detected candidate is not a mastery claim or a student error reflection. */
export function discardEvidenceCandidate(itemId: string): void {
  if (!getEvidence(itemId)) throw new Error('没有真实候选题证据');
  assertEditable(itemId);
  if (getDb().prepare('SELECT 1 FROM error_diagnosis WHERE item_id=? LIMIT 1').get(itemId)) throw new Error('已经提交反思的题目请使用复习价值归档流程');
  getDb().prepare("UPDATE error_item SET status='archived_not_worth_review',needs_correction=0,archived_reason='学生排除的非错题候选',updated_at=? WHERE id=?").run(now(), itemId);
  audit('candidate_excluded', 'item', itemId);
}

export async function saveEvidence(itemId: string, input: unknown, verified: boolean): Promise<void> {
  if (verified && checkingCrops.has(itemId)) throw new Error('裁图检查正在进行，暂不能确认');
  const previous = getEvidence(itemId); if (!previous) throw new Error('没有可校对证据');
  assertEditable(itemId);
  const content = validateEvidence(input);
  const cropAudit = previous.cropAudit?.evidenceHash === evidenceFingerprint(content) ? previous.cropAudit : null;
  if (verified) {
    assertPrintable(content, true);
    assertCropAudit(content, cropAudit, sha256(fs.readFileSync(evidenceSource(itemId).storagePath)));
  }
  const revision = previous.revision + 1;
  const pendingDiagrams: Array<{ target: string; bytes: Buffer }> = [];
  if (verified) {
    const source = fs.readFileSync(evidenceSource(itemId).storagePath);
    for (const [index, region] of content.regions.entries()) {
      if (region.kind !== 'diagram') continue;
      const target = diagramPath(itemId, revision, index);
      const bytes = await cropPhoto(source, region.box);
      pendingDiagrams.push({ target, bytes });
    }
  }
  assertEditable(itemId);
  if (getEvidence(itemId)?.revision !== previous.revision) throw new Error('证据已被其他操作更新，请重新加载');
  if (verified) assertCropAudit(content, cropAudit, sha256(fs.readFileSync(evidenceSource(itemId).storagePath)));
  // No awaits between the version check, cache publication and database commit.
  for (const { target, bytes } of pendingDiagrams) {
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  }
  const db = getDb(); db.exec('BEGIN');
  try {
    db.prepare('UPDATE evidence_record SET content_json=?,revision=?,verified=?,crop_audit_json=?,diagnosis_json=NULL,coaching_json=NULL,updated_at=? WHERE item_id=?')
      .run(JSON.stringify(content), revision, verified ? 1 : 0, cropAudit ? JSON.stringify(cropAudit) : null, now(), itemId);
    db.prepare(`UPDATE error_item SET text_excerpt=?,subject=?,chapter=?,knowledge_tags=?,question_type=?,status=?,needs_correction=?,updated_at=? WHERE id=?`)
      .run(content.questionText, content.subject, content.chapter, JSON.stringify(content.knowledgeTags), content.questionType,
        verified ? 'ready_for_reflection' : 'needs_review', verified ? 0 : 1, now(), itemId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  audit('evidence_corrected', 'item', itemId);
}

export async function analyzeEvidence(itemId: string, stage: 'diagnose' | 'coach'): Promise<void> {
  const record = getEvidence(itemId); if (!record?.verified) throw new Error('请先校对并确认题目与作答证据');
  assertEvidenceReady(itemId, record);
  assertEditable(itemId);
  const provider = getAiProvider();
  if (!(provider instanceof StagedProvider)) throw new Error('演示模式不执行真实证据诊断，请配置百炼');
  const source = evidenceSource(itemId);
  const result = stage === 'diagnose' ? await provider.diagnose(record.content, source)
    : record.diagnosis ? await provider.coach(record.content, record.diagnosis.value, source)
      : (() => { throw new Error('请先生成有证据的诊断'); })();
  assertEditable(itemId);
  const current = getEvidence(itemId);
  if (current?.revision !== record.revision) throw new Error('分析期间证据已更新，本次分析不保存，请重试');
  if (JSON.stringify(current.cropAudit) !== JSON.stringify(record.cropAudit)) throw new Error('分析期间裁图检查已更新，本次分析不保存');
  assertEvidenceReady(itemId, current);
  if (stage === 'coach' && JSON.stringify(current.diagnosis) !== JSON.stringify(record.diagnosis)) throw new Error('分析期间诊断已更新，旧提示不保存，请重试');
  if (stage === 'diagnose') getDb().prepare('UPDATE evidence_record SET diagnosis_json=?,coaching_json=NULL,updated_at=? WHERE item_id=?').run(JSON.stringify(result), now(), itemId);
  else getDb().prepare('UPDATE evidence_record SET coaching_json=?,updated_at=? WHERE item_id=?').run(JSON.stringify(result), now(), itemId);
  audit(`evidence_${stage}`, 'item', itemId);
}
