import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../../src/db/schema.js';

export function classificationDb(sql = SCHEMA_SQL): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(sql);
  return db;
}

export function classificationStudent(db: DatabaseSync, id: string): void {
  db.prepare('INSERT INTO student_profile (id,nickname,created_at) VALUES (?,?,?)').run(id, '合成学生', '2026-10-16T00:00:00Z');
}

export function classificationItem(db: DatabaseSync, studentId: string, id: string): void {
  db.prepare('INSERT INTO source_batch (id,student_id,created_at) VALUES (?,?,?)').run(`batch-${id}`, studentId, '2026-10-16');
  db.prepare(`INSERT INTO source_asset (id,batch_id,filename,mime,size,content_hash,storage_path,created_at)
    VALUES (?,?,'synthetic.jpg','image/jpeg',1,'synthetic','synthetic','2026-10-16')`).run(`asset-${id}`, `batch-${id}`);
  db.prepare(`INSERT INTO error_item (id,student_id,batch_id,asset_id,item_index,subject,knowledge_tags,status,created_at,updated_at)
    VALUES (?,?,?,?,0,'数学','["旧知识点"]','needs_recheck','2026-10-16','2026-10-16')`).run(id, studentId, `batch-${id}`, `asset-${id}`);
}
