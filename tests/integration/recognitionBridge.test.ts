import { resetMaterials } from '../helpers/resetMaterials.js';
/**
 * T3 桥：v2 上传的识别任务 → 错题记录（RED → GREEN）。
 * 覆盖简报 9 条 RED：未登记不桥、建题过滤与徽标、裁图可用、幂等、processing 不桥与增量、
 * 证据更新与反思锁定、duplicate_source、写入失败 fail-closed 且不影响其他任务、旧库迁移。
 * 测试用临时移动数据目录与合成图片；不调真实模型、不读 .env 与 data/。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Evidence } from '../../src/ai/evidence.js';
import { getDb, migrateBridgeSchema, now } from '../../src/db/connection.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { ensureStudentProfile } from '../../src/services/studentService.js';
import { getQuestionCrop } from '../../src/services/evidenceService.js';
import { MobileRecognitionStore } from '../../src/mobile/store.js';
import type { RecognitionQuestion, RecognitionVerification, StoredRecognitionJob } from '../../src/mobile/contracts.js';
import { bridgeJob, bridgePending, registerV2Photo } from '../../src/bridge/recognitionToItems.js';

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

beforeAll(() => {
  ensureStudentProfile();
});

// 每个用例清空桥接相关表（共享测试库），保留学生档案。
beforeEach(() => {
  const database = getDb();
  resetMaterials(database);
  for (const table of ['mobile_item_link', 'evidence_record', 'error_diagnosis', 'error_item', 'asset_origin', 'source_asset', 'source_batch', 'v2_photo']) {
    database.prepare(`DELETE FROM ${table}`).run();
  }
});

const CHECKS: RecognitionVerification = { textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] };

async function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
}

function evidence(number: string, text = '已知 x+y=3，求 x 的值。', teacherNote = false): Evidence {
  const regions: Evidence['regions'] = [{ id: 's1', kind: 'student_work', box: { x: .2, y: .2, width: .2, height: .2 }, confidence: .9, cleanForPrint: false }];
  const observations: Evidence['observations'] = [{ id: 'o1', kind: 'student_work', text: 'x=1', regionId: 's1', confidence: .9 }];
  if (teacherNote) {
    regions.push({ id: 't1', kind: 'teacher_note', box: { x: .6, y: .1, width: .2, height: .1 }, confidence: .9, cleanForPrint: false });
    observations.push({ id: 'o2', kind: 'teacher_note', text: '粗心', regionId: 't1', confidence: .9 });
  }
  return {
    version: 1, questionNumber: number, questionText: text, subject: '数学', chapter: '方程',
    knowledgeTags: ['一元一次方程'], questionType: '计算',
    questionRegion: { x: .1, y: .1, width: .8, height: .8 }, requiresDiagram: false,
    regions, observations, uncertainties: [],
  };
}

let seq = 0;
function question(partial: Partial<RecognitionQuestion> & { number?: string } = {}): RecognitionQuestion {
  seq += 1;
  const number = partial.number ?? String(seq);
  return {
    id: crypto.randomUUID(), number, revision: 1, status: 'ready', selectionEvidence: 'marked_wrong',
    evidence: evidence(number), verification: { ...CHECKS }, questionMediaId: null, diagramMediaIds: [],
    error: null, confirmedAt: null, ...partial,
  };
}

async function tempDir(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-t3-bridge-'));
  roots.push(dir);
  return dir;
}

async function makeJob(dir: string, mutate: (job: StoredRecognitionJob) => void, sourceBytes?: Buffer): Promise<string> {
  const store = await MobileRecognitionStore.open(dir);
  const bytes = sourceBytes ?? await jpeg();
  const { job } = await store.createJob({ idempotencyKey: crypto.randomUUID(), photoName: 'photo.jpg', sourceBytes: bytes, normalizedBytes: bytes });
  await store.updateJob(job.id, j => {
    j.phase = 'complete'; j.status = 'completed'; j.revision += 1;
    mutate(j);
  });
  return job.id;
}

const db = () => getDb();
const itemCount = () => (db().prepare('SELECT COUNT(*) AS n FROM error_item').get() as { n: number }).n;
const linkCount = () => (db().prepare('SELECT COUNT(*) AS n FROM mobile_item_link').get() as { n: number }).n;
const photoRow = (jobId: string) => db().prepare('SELECT * FROM v2_photo WHERE job_id = ?').get(jobId) as
  { job_id: string; student_id: string; registered_at: string; bridged_revision: number | null; bridge_error: string | null;
    batch_id: string | null; asset_id: string | null; source_hash: string | null } | undefined;
const batchCount = () => (db().prepare('SELECT COUNT(*) AS n FROM source_batch').get() as { n: number }).n;
const assetCount = () => (db().prepare('SELECT COUNT(*) AS n FROM source_asset').get() as { n: number }).n;

describe('T3 桥：v2 识别任务 → 错题记录', () => {
  it('RED1 未登记的终态任务不建题', async () => {
    const dir = await tempDir();
    const jobId = await makeJob(dir, j => { j.questions = [question({ number: '1' })]; });
    bridgeJob(jobId, dir);
    bridgePending(dir);
    expect(itemCount()).toBe(0);
    expect(photoRow(jobId)).toBeUndefined();
  });

  it('RED2 登记终态任务：只建有批改/订正痕迹的可用题，徽标与短 ID 正确', async () => {
    const dir = await tempDir();
    const questions = [
      question({ number: '1', status: 'ready', selectionEvidence: 'marked_wrong' }),
      question({ number: '2', status: 'needs_check', selectionEvidence: 'corrected', evidence: evidence('2', '订正题。', true) }),
      question({ number: '3', status: 'ready', selectionEvidence: 'unmarked' }),
      question({ number: '4', status: 'failed', selectionEvidence: 'marked_wrong', evidence: null, verification: null }),
      question({ number: '5', status: 'ready', selectionEvidence: 'marked_right' }),
    ];
    const jobId = await makeJob(dir, j => { j.questions = questions; });
    registerV2Photo(jobId);
    bridgeJob(jobId, dir);

    const items = db().prepare('SELECT * FROM error_item ORDER BY item_index').all() as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(db().prepare('SELECT item_id FROM material_item_link ORDER BY item_id').all()).toEqual(items.map(i=>({item_id:i.id})).sort((a,b)=>String(a.item_id).localeCompare(String(b.item_id))));
    for (const item of items) {
      expect(item.status).toBe('ready_for_reflection');
      expect(item.short_id).toMatch(/^M-\d+$/);
      expect(item.needs_correction).toBe(0);
    }
    const records = db().prepare('SELECT * FROM evidence_record ORDER BY item_id').all() as Array<Record<string, unknown>>;
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.verified).toBe(0);
      expect(JSON.parse(record.auto_checks_json as string)).toMatchObject({ textComplete: true });
    }
    const byIndex = db().prepare(
      `SELECT ei.item_index, er.confidence_badge, ei.has_work_img, ei.has_teacher_note, ei.text_excerpt
       FROM error_item ei JOIN evidence_record er ON er.item_id = ei.id ORDER BY ei.item_index`,
    ).all() as Array<Record<string, unknown>>;
    expect(byIndex[0]).toMatchObject({ item_index: 0, confidence_badge: 'ok', has_work_img: 1, has_teacher_note: 0 });
    expect(byIndex[1]).toMatchObject({ item_index: 1, confidence_badge: 'low', has_work_img: 1, has_teacher_note: 1 });
    expect(String(byIndex[0]!.text_excerpt)).toContain('求 x 的值');
    expect(photoRow(jobId)?.bridged_revision).toBe(2);
    expect(photoRow(jobId)?.bridge_error).toBeNull();
    expect(linkCount()).toBe(2);
  });

  it('RED3 桥接出的题可裁图（storage_path 与证据坐标可用）', async () => {
    const dir = await tempDir();
    const jobId = await makeJob(dir, j => { j.questions = [question({ number: '1' })]; });
    registerV2Photo(jobId);
    bridgeJob(jobId, dir);
    const item = db().prepare('SELECT id FROM error_item').get() as { id: string };
    const crop = await getQuestionCrop(item.id);
    expect(crop[0]).toBe(0xff);
    expect(crop[1]).toBe(0xd8);
  });

  it('RED4 同一任务重复桥接不重复建题', async () => {
    const dir = await tempDir();
    const jobId = await makeJob(dir, j => { j.questions = [question({ number: '1' })]; });
    registerV2Photo(jobId);
    bridgeJob(jobId, dir);
    bridgeJob(jobId, dir);
    bridgePending(dir);
    expect(itemCount()).toBe(1);
    expect(linkCount()).toBe(1);
  });

  it('RED5 processing 不桥；failed 题重试成 ready 且 revision 增大后只新增该题', async () => {
    const dir = await tempDir();
    const store = await MobileRecognitionStore.open(dir);
    const bytes = await jpeg();
    const { job } = await store.createJob({ idempotencyKey: crypto.randomUUID(), photoName: 'p.jpg', sourceBytes: bytes, normalizedBytes: bytes });
    const failed = question({ number: '2', status: 'failed', evidence: null, verification: null });
    await store.updateJob(job.id, j => {
      j.phase = 'complete'; j.status = 'partial'; j.revision += 1;
      j.questions = [question({ number: '1' }), failed];
    });
    registerV2Photo(job.id);
    bridgeJob(job.id, dir);
    expect(itemCount()).toBe(1);

    // 回到 processing：不桥。
    await store.updateJob(job.id, j => { j.status = 'processing'; j.phase = 'questions'; j.revision += 1; });
    bridgeJob(job.id, dir);
    expect(itemCount()).toBe(1);

    // failed 题重试成功，任务回到终态且 revision 增大：只新增这一道。
    await store.updateJob(job.id, j => {
      const target = j.questions.find(q => q.id === failed.id)!;
      target.status = 'ready'; target.evidence = evidence('2', '重试成功的题。'); target.verification = { ...CHECKS };
      target.revision += 1;
      j.status = 'completed'; j.phase = 'complete'; j.revision += 1;
    });
    bridgeJob(job.id, dir);
    expect(itemCount()).toBe(2);
    const second = db().prepare('SELECT text_excerpt FROM error_item ORDER BY item_index').all() as Array<{ text_excerpt: string }>;
    expect(second[1]!.text_excerpt).toContain('重试成功的题');
  });

  it('RED6 无反思时证据随 question.revision 更新；已有反思则不动', async () => {
    const dir = await tempDir();
    const store = await MobileRecognitionStore.open(dir);
    const bytes = await jpeg();
    const { job } = await store.createJob({ idempotencyKey: crypto.randomUUID(), photoName: 'p.jpg', sourceBytes: bytes, normalizedBytes: bytes });
    await store.updateJob(job.id, j => {
      j.phase = 'complete'; j.status = 'completed'; j.revision += 1;
      j.questions = [question({ number: '1' })];
    });
    registerV2Photo(job.id);
    bridgeJob(job.id, dir);
    const itemId = (db().prepare('SELECT id FROM error_item').get() as { id: string }).id;

    // question.revision 增大、无反思无练习包：证据更新。
    await store.updateJob(job.id, j => {
      j.questions[0]!.revision += 1;
      j.questions[0]!.evidence = evidence('1', '更新后的题干。');
      j.questions[0]!.status = 'needs_check';
      j.revision += 1;
    });
    bridgeJob(job.id, dir);
    let record = db().prepare('SELECT content_json, confidence_badge FROM evidence_record WHERE item_id = ?').get(itemId) as { content_json: string; confidence_badge: string };
    expect(record.content_json).toContain('更新后的题干');
    expect(record.confidence_badge).toBe('low');
    expect((db().prepare('SELECT question_revision FROM mobile_item_link WHERE item_id = ?').get(itemId) as { question_revision: number }).question_revision).toBe(2);

    // 已有反思：不动证据。
    db().prepare(
      "INSERT INTO error_diagnosis (id, item_id, attempt_state, cause, mastery_feeling, review_value, submitted_by, created_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run('diag-test-1', itemId, '其他', '计算', 2, '可以再做', 'student', now());
    await store.updateJob(job.id, j => {
      j.questions[0]!.revision += 1;
      j.questions[0]!.evidence = evidence('1', '不应生效的题干。');
      j.revision += 1;
    });
    bridgeJob(job.id, dir);
    record = db().prepare('SELECT content_json FROM evidence_record WHERE item_id = ?').get(itemId) as { content_json: string; confidence_badge: string };
    expect(record.content_json).toContain('更新后的题干');
    expect(record.content_json).not.toContain('不应生效的题干');
  });

  it('RED7 另一任务 sourceHash 相同：不建题，bridge_error 以 duplicate_source: 开头', async () => {
    const dir = await tempDir();
    const shared = await jpeg();
    const first = await makeJob(dir, j => { j.questions = [question({ number: '1' })]; }, shared);
    const second = await makeJob(dir, j => { j.questions = [question({ number: '1' })]; }, shared);
    registerV2Photo(first);
    registerV2Photo(second);
    bridgeJob(first, dir);
    bridgeJob(second, dir);
    expect(itemCount()).toBe(1);
    const row = photoRow(second);
    expect(row?.bridge_error).toMatch(/^duplicate_source:/);
    expect(row?.bridge_error).toContain(first);
    expect(row?.bridged_revision).toBeNull();
  });

  it('RED8 写入失败：该任务零行写入并记 bridge_error，其他任务照常桥接', async () => {
    const dir = await tempDir();
    // 注意：sharp 生成的相同参数白图字节完全一致（sourceHash 相同），两个任务必须用不同的图。
    const red = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#ff0000' } }).jpeg().toBuffer();
    const green = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#00ff00' } }).jpeg().toBuffer();
    const broken = await makeJob(dir, j => { j.questions = [question({ number: '1' })]; }, red);
    const healthy = await makeJob(dir, j => { j.questions = [question({ number: '1' })]; }, green);
    registerV2Photo(broken);
    registerV2Photo(healthy);
    // 删掉规范化原图，让桥接在准备 source_asset 时失败。
    const brokenJob = JSON.parse(fs.readFileSync(path.join(dir, 'jobs', broken, 'job.json'), 'utf8')) as StoredRecognitionJob;
    fs.rmSync(path.join(dir, 'jobs', broken, 'media', brokenJob.media[brokenJob.sourceMediaId]!.filename));

    bridgePending(dir);

    const brokenRow = photoRow(broken);
    expect(brokenRow?.bridge_error).toBeTruthy();
    expect(brokenRow?.bridged_revision).toBeNull();
    expect(photoRow(healthy)?.bridged_revision).toBe(2);
    // broken 零行写入：唯一的题属于 healthy。
    expect(itemCount()).toBe(1);
    expect(linkCount()).toBe(1);
    const batches = db().prepare('SELECT COUNT(*) AS n FROM source_batch').get() as { n: number };
    expect(batches.n).toBe(1);
  });

  it('R1-F1a 重试后第二次桥接复用同一批次与原图', async () => {
    const dir = await tempDir();
    const store = await MobileRecognitionStore.open(dir);
    const bytes = await jpeg();
    const { job } = await store.createJob({ idempotencyKey: crypto.randomUUID(), photoName: 'p.jpg', sourceBytes: bytes, normalizedBytes: bytes });
    const failed = question({ number: '2', status: 'failed', evidence: null, verification: null });
    await store.updateJob(job.id, j => {
      j.phase = 'complete'; j.status = 'partial'; j.revision += 1;
      j.questions = [question({ number: '1' }), failed];
    });
    registerV2Photo(job.id);
    bridgeJob(job.id, dir);
    expect(assetCount()).toBe(1);
    expect(batchCount()).toBe(1);
    const firstAsset = photoRow(job.id)!.asset_id;
    expect(firstAsset).toBeTruthy();

    await store.updateJob(job.id, j => {
      const target = j.questions.find(q => q.id === failed.id)!;
      target.status = 'ready'; target.evidence = evidence('2', '重试成功的题。'); target.verification = { ...CHECKS };
      target.revision += 1;
      j.status = 'completed'; j.revision += 1;
    });
    bridgeJob(job.id, dir);

    expect(assetCount()).toBe(1);
    expect(batchCount()).toBe(1);
    expect(photoRow(job.id)?.asset_id).toBe(firstAsset);
    const assets = db().prepare('SELECT DISTINCT asset_id FROM error_item').all() as Array<{ asset_id: string }>;
    expect(assets).toHaveLength(1);
    expect(assets[0]!.asset_id).toBe(firstAsset);
  });

  it('R1-F1b 无可桥接题的任务不建批次与原图，bridged_revision 照写', async () => {
    const dir = await tempDir();
    const jobId = await makeJob(dir, j => {
      j.status = 'failed'; j.phase = 'inventory'; j.questions = [];
      j.error = { code: 'invalid_image', message: '无法识别', stage: 'inventory', retryable: false };
    });
    registerV2Photo(jobId);
    bridgeJob(jobId, dir);
    expect(itemCount()).toBe(0);
    expect(batchCount()).toBe(0);
    expect(assetCount()).toBe(0);
    expect(photoRow(jobId)?.bridged_revision).toBe(2);
    // 再桥接一次（revision 未变）：仍无任何行，不反复重试建批次。
    bridgeJob(jobId, dir);
    expect(batchCount()).toBe(0);
    expect(assetCount()).toBe(0);
  });

  it('R1-F2 人工放行（manualRelease）的题徽标为 low', async () => {
    const dir = await tempDir();
    const jobId = await makeJob(dir, j => {
      j.questions = [
        question({ number: '1', status: 'confirmed', confirmedAt: new Date().toISOString(), manualRelease: true }),
        question({ number: '2', status: 'confirmed', confirmedAt: new Date().toISOString() }),
      ];
    });
    registerV2Photo(jobId);
    bridgeJob(jobId, dir);
    const badges = db().prepare(
      'SELECT ei.item_index, er.confidence_badge FROM error_item ei JOIN evidence_record er ON er.item_id = ei.id ORDER BY ei.item_index',
    ).all() as Array<{ item_index: number; confidence_badge: string }>;
    expect(badges).toEqual([
      { item_index: 0, confidence_badge: 'low' },
      { item_index: 1, confidence_badge: 'ok' },
    ]);
  });

  it('R1-F3 同哈希照片只有先登记的那张建题（按 registered_at 判重，不读磁盘）', async () => {
    const dir = await tempDir();
    const store = await MobileRecognitionStore.open(dir);
    const shared = await jpeg();
    const create = async (terminal: boolean): Promise<string> => {
      const { job } = await store.createJob({ idempotencyKey: crypto.randomUUID(), photoName: 'p.jpg', sourceBytes: shared, normalizedBytes: shared });
      await store.updateJob(job.id, j => {
        j.revision += 1;
        if (terminal) { j.phase = 'complete'; j.status = 'completed'; j.questions = [question({ number: '1' })]; }
        else { j.status = 'processing'; j.phase = 'questions'; }
      });
      return job.id;
    };
    const first = await create(false);   // 先登记，未到终态
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = await create(true);   // 后登记，同哈希，已终态
    registerV2Photo(first);
    bridgeJob(first, dir);               // 非终态：不桥，但应已把 source_hash 写入 v2_photo
    await new Promise(resolve => setTimeout(resolve, 5));
    registerV2Photo(second);
    bridgeJob(second, dir);              // 后登记 → duplicate，不建题
    expect(itemCount()).toBe(0);
    expect(photoRow(second)?.bridge_error).toMatch(/^duplicate_source:/);
    expect(photoRow(second)?.bridge_error).toContain(first);

    // 先登记的任务到终态后正常建题。
    await store.updateJob(first, j => {
      j.status = 'completed'; j.phase = 'complete'; j.questions = [question({ number: '1' })]; j.revision += 1;
    });
    bridgeJob(first, dir);
    expect(itemCount()).toBe(1);
    expect(photoRow(first)?.bridge_error).toBeNull();
  });

  it('R2-RED 同时刻登记同哈希：已成功桥接者优先，job_id 较大的一方仍判重复', async () => {
    const dir = await tempDir();
    const shared = await jpeg();
    const a = await makeJob(dir, j => { j.questions = [question({ number: '1' })]; }, shared);
    const b = await makeJob(dir, j => { j.questions = [question({ number: '1' })]; }, shared);
    // 稳定复现：second 的 UUID 字典序小于 first，registered_at 完全相同。
    const [second, first] = [a, b].sort();
    registerV2Photo(first!);
    registerV2Photo(second!);
    db().prepare('UPDATE v2_photo SET registered_at = ?').run('2026-09-29T12:00:00.000Z');
    bridgeJob(first!, dir);
    bridgeJob(second!, dir);
    expect(itemCount()).toBe(1);
    expect(photoRow(second!)?.bridge_error).toMatch(/^duplicate_source:/);
    expect(photoRow(second!)?.bridge_error).toContain(first!);
  });

  it('R2-F4 同哈希后登记者先被直接桥接：先登记者再桥接判重复，仍只有一份建题', async () => {
    const dir = await tempDir();
    const shared = await jpeg();
    const first = await makeJob(dir, j => { j.questions = [question({ number: '1' })]; }, shared);
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = await makeJob(dir, j => { j.questions = [question({ number: '1' })]; }, shared);
    registerV2Photo(first);
    registerV2Photo(second);
    bridgeJob(second, dir);            // 后登记者先桥接（此时 first 的 source_hash 未落库）→ second 建题
    bridgeJob(first, dir);             // second 已成功桥接 → first 判重复
    expect(itemCount()).toBe(1);
    expect(photoRow(second)?.bridge_error).toBeNull();
    expect(photoRow(second)?.bridged_revision).toBe(2);
    expect(photoRow(first)?.bridge_error).toMatch(/^duplicate_source:/);
    expect(photoRow(first)?.bridge_error).toContain(second);
    expect(photoRow(first)?.bridged_revision).toBeNull();
  });

  it('RED9 旧库（无新列/新表）迁移后自动补齐，旧数据不丢', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'old.db');
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE student_profile (id TEXT PRIMARY KEY, nickname TEXT NOT NULL, grade TEXT NOT NULL DEFAULT '初三',
        subjects TEXT NOT NULL DEFAULT '["数学"]', weekend_pref TEXT DEFAULT '周六上午', created_at TEXT NOT NULL);
      CREATE TABLE evidence_record (item_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1,
        content_json TEXT NOT NULL, provenance_json TEXT NOT NULL DEFAULT '[]', verified INTEGER NOT NULL DEFAULT 0,
        diagnosis_json TEXT, coaching_json TEXT, crop_audit_json TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE v2_photo (job_id TEXT PRIMARY KEY, student_id TEXT NOT NULL,
        registered_at TEXT NOT NULL, bridged_revision INTEGER, bridge_error TEXT);
    `);
    old.prepare("INSERT INTO student_profile (id, nickname, created_at) VALUES ('stu_old', '旧学生', '2026-09-01T00:00:00.000Z')").run();
    old.prepare("INSERT INTO evidence_record (item_id, content_json, updated_at) VALUES ('itm_old', '{}', '2026-09-01T00:00:00.000Z')").run();
    old.prepare("INSERT INTO v2_photo (job_id, student_id, registered_at, bridged_revision) VALUES ('job-old', 'stu_old', '2026-09-01T00:00:00.000Z', 3)").run();
    old.close();

    const reopened = new DatabaseSync(file);
    reopened.exec(SCHEMA_SQL);
    migrateBridgeSchema(reopened);
    const evidenceCols = (reopened.prepare('PRAGMA table_info(evidence_record)').all() as Array<{ name: string }>).map(c => c.name);
    expect(evidenceCols).toContain('auto_checks_json');
    expect(evidenceCols).toContain('confidence_badge');
    // R1：旧形状的 v2_photo 也补齐 batch_id / asset_id / source_hash。
    const photoCols = (reopened.prepare('PRAGMA table_info(v2_photo)').all() as Array<{ name: string }>).map(c => c.name);
    expect(photoCols).toContain('batch_id');
    expect(photoCols).toContain('asset_id');
    expect(photoCols).toContain('source_hash');
    const tables = (reopened.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name);
    expect(tables).toContain('v2_photo');
    expect(tables).toContain('mobile_item_link');
    expect(reopened.prepare('SELECT nickname FROM student_profile WHERE id = ?').get('stu_old')).toEqual({ nickname: '旧学生' });
    expect(reopened.prepare('SELECT content_json FROM evidence_record WHERE item_id = ?').get('itm_old')).toEqual({ content_json: '{}' });
    expect(reopened.prepare('SELECT bridged_revision FROM v2_photo WHERE job_id = ?').get('job-old')).toEqual({ bridged_revision: 3 });
    reopened.close();
  });
});
