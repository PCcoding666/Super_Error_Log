/**
 * F6 回归：finalizeBatch 必须把 empty/unsupported/too_large 计入失败；
 * duplicate 是成功跳过，不计失败。
 */
import { describe, expect, it } from 'vitest';
import { getDb, newId, now } from '../../src/db/connection.js';
import { finalizeBatch } from '../../src/services/batchService.js';
import { createProfile } from '../../src/services/studentService.js';

function makeBatch(studentId: string, assetStatuses: string[]): string {
  const db = getDb();
  const batchId = newId('bat');
  db.prepare(
    "INSERT INTO source_batch (id, student_id, status, total_files, created_at) VALUES (?,?,?,?,?)",
  ).run(batchId, studentId, 'processing', assetStatuses.length, now());
  assetStatuses.forEach((st, i) => {
    db.prepare(
      `INSERT INTO source_asset (id, batch_id, filename, mime, size, content_hash, status, storage_path, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(newId('ast'), batchId, `f${i}.png`, 'image/png', 100, `h_${batchId}_${i}`, st, '/tmp/x', now());
  });
  return batchId;
}

function batchRow(batchId: string): { status: string; done_files: number; failed_files: number } {
  return getDb()
    .prepare('SELECT status, done_files, failed_files FROM source_batch WHERE id = ?')
    .get(batchId) as { status: string; done_files: number; failed_files: number };
}

describe('finalizeBatch 批次状态汇总', () => {
  const studentId = createProfile({ nickname: '批次测试', subjects: ['数学'], weekendPref: '周六上午' }).id;

  it('全部 empty/unsupported/too_large → failed', () => {
    const batchId = makeBatch(studentId, ['empty', 'unsupported', 'too_large']);
    finalizeBatch(batchId);
    const row = batchRow(batchId);
    expect(row.status).toBe('failed');
    expect(row.failed_files).toBe(3);
  });

  it('部分成功部分坏文件 → partial，坏文件各状态都计数', () => {
    const batchId = makeBatch(studentId, ['done', 'done', 'empty', 'failed']);
    finalizeBatch(batchId);
    const row = batchRow(batchId);
    expect(row.status).toBe('partial');
    expect(row.done_files).toBe(2);
    expect(row.failed_files).toBe(2);
  });

  it('全部 duplicate（成功跳过）→ done', () => {
    const batchId = makeBatch(studentId, ['duplicate', 'duplicate']);
    finalizeBatch(batchId);
    expect(batchRow(batchId).status).toBe('done');
  });

  it('全部 done → done', () => {
    const batchId = makeBatch(studentId, ['done', 'done', 'done']);
    finalizeBatch(batchId);
    const row = batchRow(batchId);
    expect(row.status).toBe('done');
    expect(row.done_files).toBe(3);
    expect(row.failed_files).toBe(0);
  });
});
