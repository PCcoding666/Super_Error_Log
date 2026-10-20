import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { migrateBridgeSchema } from '../../src/db/connection.js';
import { migrateMaterials } from '../../src/materials/schema.js';
import { backfillLegacyMaterials } from '../../src/materials/legacy.js';
import { MaterialStore } from '../../src/materials/store.js';
const dirs: string[] = []; const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}); });
const tables = ['student_profile','source_batch','source_asset','error_item','evidence_record','mobile_item_link','error_diagnosis','review_packet','review_packet_item','v2_print_snapshot','review_attempt','ai_run'];
function fixture() {
  const dir=mkdtempSync(path.join(os.tmpdir(),'material-migration-')); dirs.push(dir);
  const media=path.join(dir,'synthetic.jpg'); writeFileSync(media,Buffer.from('synthetic-original-media'));
  const db=new DatabaseSync(path.join(dir,'old.db')); dbs.push(db); db.exec('PRAGMA foreign_keys=ON'); db.exec(SCHEMA_SQL); migrateBridgeSchema(db);
  db.exec("INSERT INTO student_profile(id,nickname,created_at) VALUES ('student','S','2026-09-01'); INSERT INTO source_batch(id,student_id,created_at) VALUES ('batch','student','2026-09-01')");
  db.prepare('INSERT INTO source_asset(id,batch_id,filename,mime,size,content_hash,storage_path,created_at) VALUES (?,?,?,?,?,?,?,?)').run('source','batch','synthetic.jpg','image/jpeg',24,'source-hash',media,'2026-09-01');
  for (let i=1;i<=4;i++) db.prepare('INSERT INTO error_item(id,student_id,batch_id,asset_id,item_index,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(`item-${i}`,'student','batch','source',i,'2026-09-01','2026-09-01');
  const evidence={version:1,questionNumber:'12',questionText:'求 x',subject:'数学',chapter:'',knowledgeTags:['方程'],questionType:'',questionRegion:{x:0,y:0,width:1,height:1},requiresDiagram:false,regions:[{id:'r',kind:'student_work',box:{x:.1,y:.1,width:.5,height:.5},confidence:.8,cleanForPrint:false}],observations:[{id:'o',kind:'student_work',text:'x=2',regionId:'r',confidence:.8}],uncertainties:[]};
  db.prepare('INSERT INTO evidence_record(item_id,content_json,updated_at) VALUES (?,?,?)').run('item-1',JSON.stringify(evidence),'2026-09-01');
  db.prepare('INSERT INTO evidence_record(item_id,content_json,updated_at) VALUES (?,?,?)').run('item-2','{"broken":true}','2026-09-01');
  db.prepare('INSERT INTO evidence_record(item_id,content_json,updated_at) VALUES (?,?,?)').run('item-4',JSON.stringify(evidence),'2026-09-01');
  db.exec("INSERT INTO mobile_item_link(item_id,job_id,question_id,question_revision) VALUES ('item-1','job','q12',1); INSERT INTO error_diagnosis(id,item_id,attempt_state,cause,mastery_feeling,review_value,created_at) VALUES ('reflection','item-1','其他','计算',2,'可以再做','2026-09-01'); INSERT INTO review_packet(id,student_id,week,created_at) VALUES ('packet','student','2026-W36','2026-09-01'); INSERT INTO review_packet_item(packet_id,item_id,position,answer_text) VALUES ('packet','item-1',0,'frozen answer'); INSERT INTO v2_print_snapshot(packet_id,status,snapshot_json,created_at) VALUES ('packet','ready','{\"frozen\":true}','2026-09-01'); INSERT INTO review_attempt(id,packet_id,item_id,completion,correct,created_at) VALUES ('return','packet','item-1','done',1,'2026-09-05')");
  return {db,media};
}
function snapshot(db: DatabaseSync) { return Object.fromEntries(tables.map(t=>[t,db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()])); }
function hash(media:string) { return createHash('sha256').update(readFileSync(media)).digest('hex'); }
describe('legacy materials',()=>{
  it('migrates twice without replacing legacy learning or running AI',()=>{
    const {db,media}=fixture(); const beforeLegacyRows=snapshot(db); const beforeMediaHashes=[hash(media)];
    migrateMaterials(db); const first=backfillLegacyMaterials(db); migrateMaterials(db); const secondMigration=backfillLegacyMaterials(db);
    expect(first.mapped).toBe(4); expect(secondMigration.mapped).toBe(0);
    const afterLegacyRows=snapshot(db); const afterMediaHashes=[hash(media)];
    expect(afterLegacyRows).toEqual(beforeLegacyRows); expect(afterMediaHashes).toEqual(beforeMediaHashes);
    const store=new MaterialStore(db,'student'); const questions=store.listQuestions();
    expect(questions).toHaveLength(4); expect(new Set(questions.map(q=>q.id)).size).toBe(4);
    const q=questions.find(q=>q.itemId==='item-1')!;
    expect(q.stem[0]!.text).toBe('求 x'); expect(q.attempts[0]!.fragments[0]!.text).toBe('x=2');
    expect(q.stem[0]!.check).toBe('unchecked');
    expect(db.prepare('SELECT count(*) n FROM material_job').get()).toEqual({n:0});
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('retains missing and invalid evidence as traceable provisional records',()=>{
    const {db}=fixture(); migrateMaterials(db); backfillLegacyMaterials(db);
    const questions=new MaterialStore(db,'student').listQuestions();
    for (const itemId of ['item-2','item-3']) { const q=questions.find(q=>q.itemId===itemId)!; expect(q.stem).toEqual([]); expect(q.missing).toContain('stem'); expect(q.unresolved.join(' ')).toMatch(/legacy_evidence/); }
    expect(db.prepare('SELECT count(*) n FROM material_legacy_map').get()).toEqual({n:4});
  });
});
