/**
 * Slice A 集成测试：上传 → 识别 → 校正 → 反思，含幂等与边界。
 * 直接调用服务层（确定性）；HTTP 层权限与表单在 E2E 覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { MockAiProvider } from '../../src/ai/mockProvider.js';
import { setAiProviderForTest } from '../../src/ai/index.js';
import { getDb } from '../../src/db/connection.js';
import { createBatch, processBatch, retryFailedAssets, normalizeImage } from '../../src/services/batchService.js';
import { correctItem, getDiagnosis, listItems, submitReflection } from '../../src/services/itemService.js';
import { createProfile } from '../../src/services/studentService.js';
import { WEEK1_DIR } from '../../src/fixtures/generate.js';

function loadFixtures(): Array<{ filename: string; mime: string; buffer: Buffer }> {
  return fs.readdirSync(WEEK1_DIR).sort().map((filename) => ({
    filename,
    mime: filename.endsWith('.pdf') ? 'application/pdf' : filename.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
    buffer: fs.readFileSync(path.join(WEEK1_DIR, filename)),
  }));
}

describe('Slice A：采集到反思', () => {
  let studentId = '';

  beforeAll(() => {
    setAiProviderForTest(new MockAiProvider());
    studentId = createProfile({ nickname: '测试学生', subjects: ['数学', '物理', '化学'], weekendPref: '周六上午' }).id;
  });

  it('上传 19 个文件 → 20 道题，3 道低置信度待校正', async () => {
    const { batchId } = await createBatch(studentId, loadFixtures());
    await processBatch(batchId);

    const db = getDb();
    const batch = db.prepare('SELECT * FROM source_batch WHERE id = ?').get(batchId) as { status: string; total_files: number };
    expect(batch.total_files).toBe(19);
    expect(batch.status).toBe('needs_attention');

    const items = listItems(studentId);
    expect(items).toHaveLength(20);
    const needReview = items.filter((i) => i.status === 'needs_review');
    expect(needReview).toHaveLength(3);
    const ready = items.filter((i) => i.status === 'ready_for_reflection');
    expect(ready).toHaveLength(17);
    // 短 ID 分配：学科前缀 + 序号
    expect(items.every((i) => i.short_id && /^[MPCX]-\d{2}$/.test(i.short_id))).toBe(true);
  });

  it('重复上传同一批文件：全部标记 duplicate，不新增题目', async () => {
    const before = listItems(studentId).length;
    const { batchId } = await createBatch(studentId, loadFixtures());
    await processBatch(batchId);
    const db = getDb();
    const assets = db.prepare('SELECT status FROM source_asset WHERE batch_id = ?').all(batchId) as Array<{ status: string }>;
    expect(assets.every((a) => a.status === 'duplicate')).toBe(true);
    expect(listItems(studentId)).toHaveLength(before);
  });

  it('边界：空文件 / 不支持格式 / 损坏图片各有明确状态，不阻塞整批', async () => {
    const { batchId } = await createBatch(studentId, [
      { filename: 'empty.png', mime: 'image/png', buffer: Buffer.alloc(0) },
      { filename: 'note.txt', mime: 'text/plain', buffer: Buffer.from('hello') },
      { filename: 'broken.png', mime: 'image/png', buffer: Buffer.from('not a real png') },
      { filename: 'W1-01.png', mime: 'image/png', buffer: fs.readFileSync(path.join(WEEK1_DIR, 'W1-01.png')) },
    ]);
    await processBatch(batchId);
    const db = getDb();
    const assets = db.prepare('SELECT filename, status FROM source_asset WHERE batch_id = ?').all(batchId) as Array<{ filename: string; status: string }>;
    const byName = Object.fromEntries(assets.map((a) => [a.filename, a.status]));
    expect(byName['empty.png']).toBe('empty');
    expect(byName['note.txt']).toBe('unsupported');
    expect(byName['broken.png']).toBe('failed');
    expect(byName['W1-01.png']).toBe('duplicate'); // 已上传过 → 幂等
    const batch = db.prepare('SELECT status FROM source_batch WHERE id = ?').get(batchId) as { status: string };
    expect(['partial', 'failed']).toContain(batch.status);
  });

  it('EXIF 旋转图片上传后被转正（宽高互换，元数据剥离）', async () => {
    const raw = fs.readFileSync(path.join(WEEK1_DIR, 'W1-18.jpg'));
    const before = await sharp(raw).metadata();
    expect(before.orientation).toBe(6);

    const normalized = await normalizeImage(raw);
    const after = await sharp(normalized).metadata();
    expect(after.orientation).toBeUndefined();
    expect(after.width).toBe(before.height);
  });

  it('AI 超时 → 文件 failed；修复后重试成功且不重复建题', async () => {
    setAiProviderForTest(new MockAiProvider(undefined, 'timeout'));
    const freshImage = async (shade: number) =>
      sharp({ create: { width: 64, height: 64, channels: 3, background: { r: shade, g: shade, b: shade } } })
        .png()
        .toBuffer();
    const files = [
      { filename: 'fresh-a.png', mime: 'image/png', buffer: await freshImage(200) },
      { filename: 'fresh-b.png', mime: 'image/png', buffer: await freshImage(120) },
    ];
    const { batchId } = await createBatch(studentId, files);
    await processBatch(batchId);
    const db = getDb();
    const failed = db.prepare("SELECT COUNT(*) AS n FROM source_asset WHERE batch_id = ? AND status = 'failed'").get(batchId) as { n: number };
    expect(failed.n).toBe(2);

    const itemsBefore = (db.prepare('SELECT COUNT(*) AS n FROM error_item WHERE batch_id = ?').get(batchId) as { n: number }).n;
    expect(itemsBefore).toBe(0);

    setAiProviderForTest(new MockAiProvider());
    expect(retryFailedAssets(batchId)).toBe(2);
    await processBatch(batchId);
    const done = db.prepare("SELECT COUNT(*) AS n FROM source_asset WHERE batch_id = ? AND status = 'done'").get(batchId) as { n: number };
    expect(done.n).toBe(2);

    // 再次重试（无 failed）→ 幂等，不新增
    expect(retryFailedAssets(batchId)).toBe(0);
    const itemsOnce = (db.prepare('SELECT COUNT(*) AS n FROM error_item WHERE batch_id = ?').get(batchId) as { n: number }).n;
    expect(itemsOnce).toBeGreaterThan(0);
    await processBatch(batchId);
    const itemsTwice = (db.prepare('SELECT COUNT(*) AS n FROM error_item WHERE batch_id = ?').get(batchId) as { n: number }).n;
    expect(itemsTwice).toBe(itemsOnce);
  });

  it('校正低置信度题目 → ready_for_reflection', async () => {
    const item = listItems(studentId).find((i) => i.status === 'needs_review')!;
    correctItem(item.id, {
      subject: '数学',
      chapter: '一元二次方程 单元',
      knowledgeTags: ['一元二次方程'],
      questionType: '计算题',
      isKeyGap: false,
    });
    const updated = listItems(studentId).find((i) => i.id === item.id)!;
    expect(updated.status).toBe('ready_for_reflection');
    expect(updated.needs_correction).toBe(0);
  });

  it('学生提交四项反思 → eligible_for_review', async () => {
    const item = listItems(studentId).find((i) => i.status === 'ready_for_reflection')!;
    const r = submitReflection(item.id, {
      attemptState: '本来会但审题计算书写失误',
      cause: '计算',
      masteryFeeling: 2,
      reviewValue: '必须再做',
    }, 'student');
    expect(r.ok).toBe(true);
    const updated = listItems(studentId).find((i) => i.id === item.id)!;
    expect(updated.status).toBe('eligible_for_review');
    expect(getDiagnosis(item.id)?.cause).toBe('计算');
  });

  it('AI 不得代写反思：submitted_by != student 被拒绝', async () => {
    const item = listItems(studentId).find((i) => i.status === 'ready_for_reflection')!;
    const r = submitReflection(item.id, {
      attemptState: '其他',
      cause: '计算',
      masteryFeeling: 3,
      reviewValue: '没必要再做',
    }, 'ai');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('学生本人');
    expect(getDiagnosis(item.id)).toBeNull();
  });
});
