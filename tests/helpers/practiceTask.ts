import crypto from 'node:crypto';
import { getDb, newId, now } from '../../src/db/connection.js';
import { ensureStudentProfile } from '../../src/services/studentService.js';

/** Synthetic learning records only. No model calls or real student material. */
export function seedPracticeItems(count = 4): string[] {
  const db = getDb(), student = ensureStudentProfile(), batch = newId('bat'), asset = newId('ast');
  db.prepare('INSERT INTO source_batch(id,student_id,status,created_at) VALUES (?,?,?,?)').run(batch,student.id,'completed',now());
  db.prepare('INSERT INTO source_asset(id,batch_id,filename,mime,size,content_hash,status,storage_path,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(asset,batch,'synthetic.jpg','image/jpeg',1,crypto.randomUUID(),'completed','synthetic-unused',now());
  return Array.from({length:count},(_,index) => {
    const id = newId('itm');
    db.prepare('INSERT INTO error_item(id,student_id,batch_id,asset_id,item_index,subject,knowledge_tags,status,text_excerpt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,student.id,batch,asset,index,'数学',JSON.stringify([`方程${index}`]),'ready_for_reflection',`求解 ${index+1}x=${index+1}`,now(),now());
    db.prepare('INSERT INTO mobile_item_link(item_id,job_id,question_id,question_revision) VALUES (?,?,?,1)').run(id,crypto.randomUUID(),crypto.randomUUID());
    return id;
  });
}

export function clearPracticeFixtures(): void {
  const db = getDb();
  for (const table of ['v2_print_snapshot','mastery_event','review_attempt','review_packet_item','review_packet','mobile_item_link','evidence_record','error_diagnosis','error_item','source_asset','source_batch']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
}
