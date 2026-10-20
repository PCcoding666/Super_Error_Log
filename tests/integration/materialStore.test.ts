import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { migrateMaterials } from '../../src/materials/schema.js';
import { MaterialStore } from '../../src/materials/store.js';
import type { Fragment } from '../../src/materials/contracts.js';

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function open(file = ':memory:') {
  const db = new DatabaseSync(file); dbs.push(db); db.exec('PRAGMA foreign_keys=ON'); db.exec(SCHEMA_SQL); migrateMaterials(db);
  db.exec("INSERT OR IGNORE INTO student_profile(id,nickname,created_at) VALUES ('alice','A','2026-10-20'),('bob','B','2026-10-20')");
  return db;
}
function source(db: DatabaseSync, owner = 'alice', suffix = '') {
  db.prepare('INSERT INTO source_batch(id,student_id,created_at) VALUES (?,?,?)').run(`batch${suffix}`, owner, '2026-10-20');
  db.prepare('INSERT INTO source_asset(id,batch_id,filename,mime,size,content_hash,storage_path,created_at) VALUES (?,?,?,?,?,?,?,?)').run(`asset${suffix}`, `batch${suffix}`, 'synthetic.jpg','image/jpeg', 1, `hash${suffix}`, '/synthetic.jpg', '2026-10-20');
}
function fragment(revision = 1): Fragment { return { assetId:'asset',fragmentId:'fragment',revision,box:{x:0,y:0,width:1,height:1},sourceHash:'hash',role:'student_work',text:revision === 1 ? 'original' : 'updated',number:'12',subpart:null,page:null,order:0,requiresDiagram:false,check:'unchecked',uncertainties:[] }; }

describe('material persistence', () => {
  it('persists a provisional question without a stem', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(),'material-store-')); dirs.push(dir);
    const file = path.join(dir, 'db.sqlite'); const db = open(file); const store = new MaterialStore(db,'alice');
    const q = store.createQuestion({ number:'12' }); const namespace = store.getWorkspace().draftNamespace;
    db.close(); dbs.splice(dbs.indexOf(db),1);
    const reopened = new MaterialStore(open(file),'alice');
    const reopenedQuestion = reopened.getQuestion(q.id)!;
    expect(reopenedQuestion.stem).toEqual([]); expect(reopenedQuestion.missing).toContain('stem');
    expect(reopened.getWorkspace().draftNamespace).toBe(namespace);
    expect(reopened.getWorkspace().draftNamespace).not.toBe(new MaterialStore(dbs[0]!, 'bob').getWorkspace().draftNamespace);
    expect(dbs[0]!.prepare('SELECT count(*) n FROM evidence_record').get()).toEqual({n:0});
  });
  it('replays capture requests and rolls back synchronous transactions including nested work', () => {
    const db = open(); const store = new MaterialStore(db,'alice'); const request = crypto.randomUUID();
    expect(store.createCapture(request)).toEqual(store.createCapture(request));
    expect(new MaterialStore(db,'bob').createCapture(request)).not.toEqual(store.createCapture(request));
    expect(() => store.transaction(() => { store.createQuestion({}); store.transaction(() => store.createQuestion({})); throw new Error('abort'); })).toThrow('abort');
    expect(store.listQuestions()).toEqual([]);
    expect(() => store.transaction(() => Promise.resolve())).toThrow(/synchronous/);
    expect(db.isTransaction).toBe(false);
  });
  it('preserves fragment revisions and link history without mixing attempts or owners', () => {
    const db = open(); source(db); source(db,'bob','-bob'); const store = new MaterialStore(db,'alice');
    const capture = store.createCapture(crypto.randomUUID());
    db.prepare('INSERT INTO material_asset(id,owner_id,capture_id,source_asset_id) VALUES (?,?,?,?)').run('asset','alice',capture.id,'asset');
    const q = store.createQuestion({number:'12'}); const second = store.createQuestion({number:'12'});
    const attempt = store.createAttempt(q.id); store.putFragment(fragment());
    const first = store.linkFragment('fragment',1,{questionId:q.id,attemptId:attempt.id});
    const basis = store.getQuestion(q.id)!.basisKey;
    store.putFragment(fragment(2));
    expect(store.getQuestion(q.id)!.attempts[0]!.fragments[0]!.text).toBe('original');
    store.linkFragment('fragment',2,{questionId:q.id,attemptId:attempt.id},first.revision);
    expect(store.getQuestion(q.id)!.basisKey).not.toBe(basis);
    expect(db.prepare('SELECT count(*) n FROM material_fragment').get()).toEqual({n:2});
    expect(() => store.linkFragment('fragment',2,{questionId:second.id,attemptId:attempt.id})).toThrow();
    expect(() => new MaterialStore(db,'bob').linkFragment('fragment',2,{questionId:q.id,attemptId:null})).toThrow();
    expect(new MaterialStore(db,'bob').getQuestion(q.id)).toBeNull();
    expect(() => db.prepare('INSERT INTO material_asset(id,owner_id,capture_id,source_asset_id) VALUES (?,?,?,?)').run('bad','alice',capture.id,'asset-bob')).toThrow();
    expect(() => store.linkFragment('fragment',2,null,first.revision)).toThrow(/revision/);
    store.linkFragment('fragment',2,null,2);
    expect(store.getQuestion(q.id)!.attempts[0]!.fragments).toEqual([]);
    expect(db.prepare('SELECT count(*) n FROM material_link_event').get()).toEqual({n:3});
  });
  it('rejects fabricated source hashes', () => {
    const db=open(); source(db); const store=new MaterialStore(db,'alice'); const capture=store.createCapture(crypto.randomUUID());
    db.prepare('INSERT INTO material_asset(id,owner_id,capture_id,source_asset_id) VALUES (?,?,?,?)').run('asset','alice',capture.id,'asset');
    expect(() => store.putFragment({...fragment(),sourceHash:'fabricated'})).toThrow(/source/);
  });
  it('never starts async transaction callbacks', () => {
    const store=new MaterialStore(open(),'alice');
    let started=false;
    expect(() => store.transaction(async () => { started=true; })).toThrow(/synchronous/);
    expect(started).toBe(false);
  });
  it('keeps answer versions and distinguishes conflicts within the same subpart', () => {
    const db=open(); const store=new MaterialStore(db,'alice'); const q=store.createQuestion({});
    function answer(id:string,revision:number,subpart:string,text:string) {
      const content={id,questionId:q.id,revision,subpart,text,source:'manual',claimedSource:null,fragmentIds:[],basisKey:'basis',stale:false,run:null};
      db.prepare('INSERT INTO material_answer(id,revision,owner_id,question_id,source,basis_key,content_json) VALUES (?,?,?,?,?,?,?)')
        .run(id,revision,'alice',q.id,'manual','basis',JSON.stringify(content));
    }
    answer('a',1,'a','2'); answer('a',2,'a','3'); answer('b',1,'b','4');
    expect(store.getQuestion(q.id)!.answers.find(a=>a.id==='a')!.text).toBe('3');
    expect(store.getQuestion(q.id)!.answerConflict).toBe(false);
    answer('other',1,'a','5'); expect(store.getQuestion(q.id)!.answerConflict).toBe(true);
    expect(db.prepare('SELECT count(*) n FROM material_answer').get()).toEqual({n:4});
    const request=crypto.randomUUID();
    db.prepare('INSERT INTO material_job(id,owner_id,request_id,kind,question_id) VALUES (?,?,?,?,?)').run('job','alice',request,'answer',q.id);
    expect(() => db.prepare('INSERT INTO material_job(id,owner_id,request_id,kind,question_id) VALUES (?,?,?,?,?)').run('duplicate','alice',request,'answer',q.id)).toThrow();
  });

});
