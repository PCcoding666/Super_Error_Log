import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { migrateMaterials } from '../../src/materials/schema.js';
import { MaterialStore } from '../../src/materials/store.js';
import { extractMaterial } from '../../src/materials/extraction.js';
import { reconcileAsset } from '../../src/materials/matching.js';
import { assignDocument, assetLinkRevision, linkRevision, relink, relinkNewAttempt, undoLink } from '../../src/materials/links.js';
import { answerBasis, gradeBasis, readQuestion, effectiveFragmentCheck, dependenciesCurrent } from '../../src/materials/queries.js';
import type { CaptureHints, Extraction, Fragment } from '../../src/materials/contracts.js';

const dbs: DatabaseSync[] = []; const dirs: string[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup(file = ':memory:') {
  const db = new DatabaseSync(file); dbs.push(db); db.exec('PRAGMA foreign_keys=ON'); db.exec(SCHEMA_SQL); migrateMaterials(db);
  db.exec("INSERT OR IGNORE INTO student_profile(id,nickname,created_at) VALUES ('alice','A','2026-10-20'),('bob','B','2026-10-20')");
  return new MaterialStore(db, 'alice');
}
let seq = 0;
function asset(store: MaterialStore, parts: Partial<Fragment>[], code: string | null = 'paper-A', hints: CaptureHints = {}) {
  const id = `asset-${++seq}`; const capture = store.createCapture(crypto.randomUUID());
  store.db.prepare('INSERT INTO source_batch(id,student_id,created_at) VALUES (?,?,?)').run(id, store.studentId, '2026-10-20');
  store.db.prepare('INSERT INTO source_asset(id,batch_id,filename,mime,size,content_hash,storage_path,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id,id,'synthetic.jpg','image/jpeg',1,id,'/synthetic.jpg','2026-10-20');
  store.db.prepare('INSERT INTO material_asset(id,owner_id,capture_id,source_asset_id,hints_json) VALUES (?,?,?,?,?)').run(id,store.studentId,capture.id,id,JSON.stringify(hints));
  const fragments = parts.map((part, order): Fragment => ({assetId:id,fragmentId:`${id}-${order}`,revision:1,sourceHash:id,box:{x:0,y:0,width:1,height:1},role:'question',text:'Question',number:'12',subpart:null,page:1,order,requiresDiagram:false,check:'passed',uncertainties:[],...part}));
  const extraction: Extraction = {assetId:id,revision:1,document:{title:'Same title',subject:'math',date:null,printedCode:code,page:1},fragments,warnings:[],runs:[]};
  for (const fragment of fragments) store.putFragment(fragment);
  store.db.prepare('UPDATE material_asset SET extraction_json=? WHERE owner_id=? AND id=?').run(JSON.stringify(extraction),store.studentId,id);
  return {id,fragments,extraction};
}
function target(store: MaterialStore, fragmentId: string) {
  return store.db.prepare('SELECT question_id,attempt_id FROM material_link_event WHERE owner_id=? AND fragment_id=? ORDER BY revision DESC LIMIT 1').get(store.studentId,fragmentId) as {question_id:string;attempt_id:string|null};
}
function only(store: MaterialStore) { return store.listQuestions()[0]!; }

describe('material linking', () => {
  it('adds the independent link counter to existing material databases idempotently', () => {
    const store=setup(); const page=asset(store,[{}]);
    store.db.exec('ALTER TABLE material_asset DROP COLUMN link_revision');
    migrateMaterials(store.db); migrateMaterials(store.db);
    expect(assetLinkRevision(store,page.id)).toBe(1);
    expect(store.db.prepare('SELECT revision FROM material_asset WHERE id=?').get(page.id)).toEqual({revision:1});
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('links unlabelled same-page roles without assigning a document from title alone', () => {
    const store=setup(); const page=asset(store,[{}, {role:'student_work',text:'Work'}, {role:'teacher_mark',text:'Teacher'}],null);
    expect(reconcileAsset(store,page.id).linked).toBe(3);
    const q=readQuestion(store,only(store).id)!;
    expect(q.documentId).toBeNull(); expect(q.stem).toHaveLength(1); expect(q.attempts[0]!.fragments).toHaveLength(1); expect(q.teacherMarks).toHaveLength(1);
  });
  it.each([false,true])('completes the same provisional question in either capture order (%s)', reverse => {
    const store=setup(); const work={role:'student_work' as const,text:'Original work'};
    const first=asset(store,reverse?[{}]:[work]); reconcileAsset(store,first.id); const before=only(store);
    const second=asset(store,reverse?[work]:[{}]); reconcileAsset(store,second.id);
    const answer=asset(store,[{role:'reference_answer',text:'Answer'}]); store.db.prepare('UPDATE material_asset SET created_at=? WHERE id=?').run('2026-10-22',answer.id); reconcileAsset(store,answer.id);
    const after=readQuestion(store,before.id)!; expect(after.id).toBe(before.id); expect(store.listQuestions()).toHaveLength(1);
    expect(after.attempts[0]!.fragments).toEqual(expect.arrayContaining(reverse?second.fragments:first.fragments));
    expect(target(store,answer.fragments[0]!.fragmentId).question_id).toBe(before.id);
  });
  it('does not merge same-number papers or title/label-only pages', () => {
    const store=setup(); for (const code of ['A','B',null,null]) { const page=asset(store,[{}],code,{label:'same'}); reconcileAsset(store,page.id); }
    expect(store.listQuestions()).toHaveLength(4); expect(new Set(store.listQuestions().filter(q=>q.documentId).map(q=>q.id)).size).toBe(2);
    expect(store.listQuestions().filter(q=>!q.documentId).every(q=>q.unresolved.includes('document'))).toBe(true);
  });
  it('requires unique code and compatible content and full subpart scope', () => {
    const store=setup(); const a=asset(store,[{text:'First'}]); reconcileAsset(store,a.id);
    const conflict=asset(store,[{text:'Different'}]); expect(reconcileAsset(store,conflict.id).pending).not.toEqual([]);
    expect(store.listQuestions()).toHaveLength(2);
    const work=asset(store,[{role:'student_work',subpart:'b',text:'b solution'}]); expect(reconcileAsset(store,work.id).pending).not.toEqual([]);
    expect(target(store,work.fragments[0]!.fragmentId).question_id).not.toBe(target(store,a.fragments[0]!.fragmentId).question_id);
  });
  it('joins distinct subparts across pages only with an explicit selected attempt', () => {
    const store=setup(); const first=asset(store,[{subpart:'a'}, {role:'student_work',subpart:'a',text:'A'}]); reconcileAsset(store,first.id); const q=only(store);
    const second=asset(store,[{role:'student_work',subpart:'b',text:'B',page:2}], 'paper-A', {questionId:q.id,attemptId:q.attempts[0]!.id}); reconcileAsset(store,second.id);
    expect(readQuestion(store,q.id)!.attempts[0]!.fragments.map(f=>f.subpart)).toEqual(['a','b']);
  });
  it('keeps independent repeat solutions pending and creates a new attempt atomically', () => {
    const store=setup(); const first=asset(store,[{}, {role:'student_work',text:'First'}]); reconcileAsset(store,first.id); const q=only(store);
    const second=asset(store,[{role:'student_work',text:'Second'}]); store.db.prepare('UPDATE material_asset SET created_at=? WHERE id=?').run('2026-10-23',second.id);
    expect(reconcileAsset(store,second.id).pending).not.toEqual([]); expect(readQuestion(store,q.id)!.attempts).toHaveLength(1);
    const result=relinkNewAttempt(store,{fragmentIds:second.fragments.map(f=>f.fragmentId),questionId:q.id,expectedRevision:linkRevision(store)});
    expect(readQuestion(store,q.id)!.attempts).toHaveLength(2); expect(target(store,second.fragments[0]!.fragmentId).attempt_id).toBe(result.attemptId);
    expect(store.listQuestions()).toHaveLength(1);
    const count=store.db.prepare('SELECT count(*) n FROM material_attempt').get();
    expect(()=>relinkNewAttempt(store,{fragmentIds:['missing'],questionId:q.id,expectedRevision:linkRevision(store)})).toThrow();
    expect(store.db.prepare('SELECT count(*) n FROM material_attempt').get()).toEqual(count);
  });
  it('reconciliation retries are idempotent and append changed fragment revisions', () => {
    const store=setup(); const page=asset(store,[{}, {role:'student_work'}]); reconcileAsset(store,page.id); const q=only(store); const rev=linkRevision(store);
    expect(reconcileAsset(store,page.id).linked).toBe(0); expect(linkRevision(store)).toBe(rev);
    const changed={...page.fragments[0]!,revision:2,text:'Revised'}; store.putFragment(changed); reconcileAsset(store,page.id);
    expect(readQuestion(store,q.id)!.stem[0]!.revision).toBe(2); expect(store.listQuestions()).toHaveLength(1);
  });
  it('confirms a whole page with asset CAS, merges provisional aliases, and undoes all links', () => {
    const store=setup(); const work=asset(store,[{role:'student_work',number:'1'},{role:'student_work',number:'2'}],null); reconcileAsset(store,work.id);
    const oldIds=work.fragments.map(f=>target(store,f.fragmentId).question_id);
    const stem=asset(store,[{number:'1'},{number:'2'}]); reconcileAsset(store,stem.id); const doc=readQuestion(store,target(store,stem.fragments[0]!.fragmentId).question_id)!.documentId!;
    const changes=assignDocument(store,{assetId:work.id,documentId:doc,expectedRevision:1});
    expect(changes.length).toBeGreaterThan(0); expect(store.listQuestions()).toHaveLength(2);
    expect(readQuestion(store,oldIds[0]!)!.attempts[0]!.fragments[0]!.assetId).toBe(work.id);
    expect(()=>assignDocument(store,{assetId:work.id,documentId:doc,expectedRevision:1})).toThrow(expect.objectContaining({status:409}));
    undoLink(store,changes[0]!.id,linkRevision(store));
    expect(store.db.prepare('SELECT document_id FROM material_asset WHERE id=?').get(work.id)).toEqual({document_id:null});
    expect(work.fragments.map(f=>target(store,f.fragmentId).question_id)).toEqual(oldIds);
    expect(store.listQuestions()).toHaveLength(4);
  });
  it('reassigns only the selected page and retires the temporary split when undone', () => {
    const store=setup(); const stem=asset(store,[{}]); reconcileAsset(store,stem.id); const original=only(store);
    const work=asset(store,[{role:'student_work'}]); reconcileAsset(store,work.id);
    const other=asset(store,[{number:'20'}],'other-paper'); reconcileAsset(store,other.id); const otherDoc=readQuestion(store,target(store,other.fragments[0]!.fragmentId).question_id)!.documentId!;
    const change=assignDocument(store,{assetId:work.id,documentId:otherDoc,expectedRevision:assetLinkRevision(store,work.id)})[0]!;
    const split=target(store,work.fragments[0]!.fragmentId).question_id;
    expect(split).not.toBe(original.id); expect(readQuestion(store,original.id)!.documentId).toBe(original.documentId);
    undoLink(store,change.id,linkRevision(store));
    expect(target(store,work.fragments[0]!.fragmentId).question_id).toBe(original.id);
    expect(store.listQuestions()).toHaveLength(2); expect(readQuestion(store,split)!.id).toBe(original.id);
  });
  it('rejects a stale relink and preserves the event needed for undo across two clients', () => {
    const dir=mkdtempSync(path.join(os.tmpdir(),'material-links-')); dirs.push(dir); const file=path.join(dir,'db.sqlite');
    const a=setup(file); const b=setup(file); const page=asset(a,[{number:'1'},{number:'2'}]); reconcileAsset(a,page.id);
    const original=target(a,page.fragments[0]!.fragmentId); const q2=target(a,page.fragments[1]!.fragmentId).question_id;
    const snapshot=linkRevision(a); expect(linkRevision(b)).toBe(snapshot);
    const change=relink(a,{fragmentIds:[page.fragments[0]!.fragmentId],target:{questionId:q2,attemptId:null},expectedRevision:snapshot});
    expect(()=>relink(b,{fragmentIds:[page.fragments[0]!.fragmentId],target:{questionId:original.question_id,attemptId:null},expectedRevision:snapshot})).toThrow(expect.objectContaining({status:409}));
    const undo=undoLink(b,change.id,linkRevision(b)); expect(target(a,page.fragments[0]!.fragmentId)).toEqual(original);
    expect(()=>undoLink(a,change.id,linkRevision(a))).toThrow(expect.objectContaining({status:409}));
    expect(a.db.prepare('SELECT id FROM material_link_event WHERE id=?').get(change.id)).toEqual({id:change.id});
    undoLink(a,undo.id,linkRevision(a)); expect(target(a,page.fragments[0]!.fragmentId).question_id).toBe(q2);
  });
  it('rejects stale whole-page assignment after another client manually moves its fragment', () => {
    const store=setup(); const page=asset(store,[{}]); reconcileAsset(store,page.id); const q=only(store);
    const other=store.createQuestion(); const fragmentId=page.fragments[0]!.fragmentId;
    relink(store,{fragmentIds:[fragmentId],target:{questionId:other.id,attemptId:null},expectedRevision:linkRevision(store)});
    expect(()=>assignDocument(store,{assetId:page.id,documentId:q.documentId!,expectedRevision:1})).toThrow(expect.objectContaining({status:409}));
    expect(target(store,fragmentId).question_id).toBe(other.id);
  });
  it('does not overwrite later overlapping changes on undo and rolls back invalid batches', () => {
    const store=setup(); const page=asset(store,[{number:'1'},{number:'2'},{number:'3'}]); reconcileAsset(store,page.id);
    const qs=page.fragments.map(f=>target(store,f.fragmentId).question_id);
    const change=relink(store,{fragmentIds:[page.fragments[0]!.fragmentId],target:{questionId:qs[1]!,attemptId:null},expectedRevision:linkRevision(store)});
    relink(store,{fragmentIds:[page.fragments[0]!.fragmentId],target:{questionId:qs[2]!,attemptId:null},expectedRevision:linkRevision(store)});
    expect(()=>undoLink(store,change.id,linkRevision(store))).toThrow(expect.objectContaining({status:409}));
    const rev=linkRevision(store); expect(()=>relink(store,{fragmentIds:[page.fragments[1]!.fragmentId,'missing'],target:{questionId:qs[0]!,attemptId:null},expectedRevision:rev})).toThrow();
    expect(linkRevision(store)).toBe(rev);
  });
  it('does not launder unchecked or wrong-subpart diagrams into complete evidence', () => {
    const store=setup(); const first=asset(store,[{subpart:'a',requiresDiagram:true,check:'low',uncertainties:['missing_diagram']}]); reconcileAsset(store,first.id); const q=only(store);
    const wrong=asset(store,[{role:'diagram',subpart:'b'}]); reconcileAsset(store,wrong.id); expect(readQuestion(store,q.id)!.missing).toContain('diagram');
    const low=asset(store,[{role:'diagram',subpart:'a',check:'unchecked'}]); reconcileAsset(store,low.id); expect(readQuestion(store,q.id)!.missing).toContain('diagram');
    const good=asset(store,[{role:'diagram',subpart:'a'}], 'paper-A', {questionId:q.id}); reconcileAsset(store,good.id);
    expect(readQuestion(store,q.id)!.missing).not.toContain('diagram');
    expect(readQuestion(store,q.id)!.stem.find(f=>f.role==='question')!.check).toBe('low');
    expect(readQuestion(store,q.id)!.stem.find(f=>f.role==='question')!.uncertainties).toContain('missing_diagram');
  });
  it('preserves learning-bound identity and refuses to merge two different learning records', () => {
    const store=setup();
    function bind(questionId:string, sourceId:string, itemId:string) {
      store.db.prepare('INSERT INTO error_item(id,student_id,batch_id,asset_id,item_index,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(itemId,'alice',sourceId,sourceId,1,'2026-10-20','2026-10-20');
      store.db.prepare('INSERT INTO material_item_link(owner_id,question_id,item_id) VALUES (?,?,?)').run('alice',questionId,itemId);
    }
    const work=asset(store,[{role:'student_work'}],null); reconcileAsset(store,work.id); const workId=target(store,work.fragments[0]!.fragmentId).question_id;
    const stem=asset(store,[{}]); reconcileAsset(store,stem.id); const stemQ=readQuestion(store,target(store,stem.fragments[0]!.fragmentId).question_id)!;
    bind(stemQ.id,stem.id,'learning-one');
    assignDocument(store,{assetId:work.id,documentId:stemQ.documentId!,expectedRevision:1});
    expect(readQuestion(store,workId)!.id).toBe(stemQ.id); expect(readQuestion(store,workId)!.itemId).toBe('learning-one');
    const other=asset(store,[{role:'teacher_mark'}],null); reconcileAsset(store,other.id); const otherId=target(store,other.fragments[0]!.fragmentId).question_id; bind(otherId,other.id,'learning-two');
    assignDocument(store,{assetId:other.id,documentId:stemQ.documentId!,expectedRevision:1});
    expect(readQuestion(store,otherId)!.id).toBe(otherId); expect(readQuestion(store,otherId)!.unresolved).toContain('learning_conflict');
    expect(readQuestion(store,stemQ.id)!.itemId).toBe('learning-one');
  });
  it('does not choose between duplicate printed-code documents or relink a manually split page on retry', () => {
    const store=setup(); const first=asset(store,[{}]); reconcileAsset(store,first.id);
    store.db.prepare('INSERT INTO material_document(id,owner_id,clues_json) VALUES (?,?,?)').run('duplicate','alice',JSON.stringify(first.extraction.document));
    const ambiguous=asset(store,[{role:'student_work'}]); expect(reconcileAsset(store,ambiguous.id).pending.length).toBeGreaterThan(0);
    expect(readQuestion(store,target(store,ambiguous.fragments[0]!.fragmentId).question_id)!.documentId).toBeNull();
    const page=asset(store,[{}, {role:'diagram'}],null); reconcileAsset(store,page.id); const other=store.createQuestion();
    relink(store,{fragmentIds:[page.fragments[1]!.fragmentId],target:{questionId:other.id,attemptId:null},expectedRevision:linkRevision(store)});
    const count=store.listQuestions().length; const rev=linkRevision(store);
    reconcileAsset(store,page.id); reconcileAsset(store,page.id);
    expect(store.listQuestions()).toHaveLength(count); expect(linkRevision(store)).toBe(rev);
  });
  it('undoes and redoes document assignment without losing the asset CAS or alias', () => {
    const store=setup(); const page=asset(store,[{role:'student_work'}],null); reconcileAsset(store,page.id); const old=only(store).id;
    const stem=asset(store,[{}]); reconcileAsset(store,stem.id); const doc=readQuestion(store,target(store,stem.fragments[0]!.fragmentId).question_id)!.documentId!;
    const change=assignDocument(store,{assetId:page.id,documentId:doc,expectedRevision:1})[0]!;
    const undo=undoLink(store,change.id,linkRevision(store));
    undoLink(store,undo.id,linkRevision(store));
    expect(readQuestion(store,old)!.documentId).toBe(doc); expect(store.listQuestions()).toHaveLength(1);
    expect(assetLinkRevision(store,page.id)).toBe(4);
    expect(store.db.prepare('SELECT revision FROM material_asset WHERE id=?').get(page.id)).toEqual({revision:1});
  });
  it('resolves missing-diagram completeness only with persisted individual verification provenance', () => {
    const store=setup(); const page=asset(store,[{requiresDiagram:true,check:'low',uncertainties:['missing_diagram']}]); reconcileAsset(store,page.id); const q=only(store);
    const diagram=asset(store,[{role:'diagram'}]); reconcileAsset(store,diagram.id);
    const fragment=page.fragments[0]!;
    expect(effectiveFragmentCheck(store,q.id,fragment.fragmentId)).toBe('low');
    const {assetId: _asset,sourceHash:_hash,revision:_rev,text:_text,check:_check,uncertainties:_uncertainties,...region}=fragment;
    const execution={stages:{
      'material-v1:1:locate':{state:'succeeded',result:{value:{candidates:[{...region,key:'candidate'}]}}},
      'material-v1:1:read:candidate':{state:'succeeded',result:{value:{text:fragment.text,uncertainties:[]}}},
      'material-v1:1:verify:candidate':{state:'succeeded',result:{value:{check:'passed',uncertainties:[]}}},
    }};
    store.db.prepare('INSERT INTO material_job(id,owner_id,request_id,kind,asset_id,input_json) VALUES (?,?,?,?,?,?)').run('verified','alice',crypto.randomUUID(),'extract',page.id,JSON.stringify({execution}));
    store.db.prepare('UPDATE material_job SET result_json=? WHERE id=?').run(JSON.stringify({assetId:page.id,revision:1,sourceHash:page.id}),'verified');
    expect(effectiveFragmentCheck(store,q.id,fragment.fragmentId)).toBe('passed');
    execution.stages['material-v1:1:verify:candidate'].result.value.check='low';
    store.db.prepare('UPDATE material_job SET input_json=? WHERE id=?').run(JSON.stringify({execution}),'verified');
    expect(effectiveFragmentCheck(store,q.id,fragment.fragmentId)).toBe('low');
    expect(readQuestion(store,q.id)!.stem.find(f=>f.role==='question')!.check).toBe('low');
    execution.stages['material-v1:1:verify:candidate'].result.value.check='passed';
    store.db.prepare('UPDATE material_job SET input_json=? WHERE id=?').run(JSON.stringify({execution}),'verified');
    store.putFragment({...fragment,revision:2,text:'Changed OCR'}); reconcileAsset(store,page.id);
    expect(effectiveFragmentCheck(store,q.id,fragment.fragmentId)).toBe('low');
    store.putFragment({...fragment,revision:3,box:{x:0,y:0,width:.5,height:.5}}); reconcileAsset(store,page.id);
    expect(effectiveFragmentCheck(store,q.id,fragment.fragmentId)).toBe('low');
    store.putFragment({...fragment,revision:4}); reconcileAsset(store,page.id);
    expect(effectiveFragmentCheck(store,q.id,fragment.fragmentId)).toBe('passed');
    store.db.prepare('UPDATE source_asset SET content_hash=? WHERE id=?').run('changed-source',page.id);
    expect(effectiveFragmentCheck(store,q.id,fragment.fragmentId)).toBe('low');
    const unknown=asset(store,[{number:null,requiresDiagram:true,check:'low',uncertainties:['missing_diagram']},{number:null,role:'diagram'}],null);
    reconcileAsset(store,unknown.id); const unknownQ=target(store,unknown.fragments[0]!.fragmentId).question_id;
    relink(store,{fragmentIds:[unknown.fragments[1]!.fragmentId],target:{questionId:unknownQ,attemptId:null},expectedRevision:linkRevision(store)});
    expect(readQuestion(store,unknownQ)!.missing).toContain('diagram');
  });
  it('uses default extraction reconciliation and records the trusted original hash for provenance', async () => {
    const store=setup(); const page=asset(store,[{}]);
    const dir=mkdtempSync(path.join(os.tmpdir(),'material-extracted-')); dirs.push(dir); const normalized=path.join(dir,'normalized.jpg'); writeFileSync(normalized,'normalized derivative');
    store.db.prepare('UPDATE source_asset SET storage_path=? WHERE id=?').run(normalized,page.id);
    store.db.prepare('INSERT INTO material_job(id,owner_id,request_id,kind,asset_id) VALUES (?,?,?,?,?)').run('extract','alice',crypto.randomUUID(),'extract',page.id);
    await extractMaterial(store,{extract:async input=>{expect(input.bytes.toString()).toBe('normalized derivative');return page.extraction;}},'extract',new AbortController().signal);
    expect(store.listQuestions()).toHaveLength(1);
    const result=store.db.prepare('SELECT result_json FROM material_job WHERE id=?').get('extract') as {result_json:string};
    expect(JSON.parse(result.result_json)).toMatchObject({assetId:page.id,sourceHash:page.id});
  });
  it('preserves in-flight extraction and durable source revision when a client manually relinks', async () => {
    const store=setup(); const page=asset(store,[{}]); reconcileAsset(store,page.id);
    const dir=mkdtempSync(path.join(os.tmpdir(),'material-inflight-')); dirs.push(dir); const normalized=path.join(dir,'normalized.jpg'); writeFileSync(normalized,'normalized');
    store.db.prepare('UPDATE source_asset SET storage_path=? WHERE id=?').run(normalized,page.id);
    store.db.prepare('INSERT INTO material_job(id,owner_id,request_id,kind,asset_id,state) VALUES (?,?,?,?,?,?)').run('inflight','alice',crypto.randomUUID(),'extract',page.id,'running');
    let release!:()=>void; let started!:()=>void;
    const ready=new Promise<void>(resolve=>{started=resolve;}); const barrier=new Promise<void>(resolve=>{release=resolve;});
    const extracting=extractMaterial(store,{extract:async()=>{started();await barrier;return page.extraction;}},'inflight',new AbortController().signal);
    await ready;
    const other=store.createQuestion(); relink(store,{fragmentIds:[page.fragments[0]!.fragmentId],target:{questionId:other.id,attemptId:null},expectedRevision:linkRevision(store)});
    release(); await extracting;
    expect(store.db.prepare('SELECT state FROM material_job WHERE id=?').get('inflight')).toEqual({state:'running'});
    expect(store.db.prepare('SELECT revision,status FROM material_asset WHERE id=?').get(page.id)).toEqual({revision:1,status:'extracted'});
    expect(target(store,page.fragments[0]!.fragmentId).question_id).toBe(other.id);
    expect(assetLinkRevision(store,page.id)).toBe(2);
  });
  it('leaves candidates with paid results pending instead of hiding their historical results during merging', () => {
    const store=setup(); const work=asset(store,[{role:'student_work'}],null); reconcileAsset(store,work.id);
    const workQ=only(store);
    store.db.prepare('INSERT INTO material_grade(id,owner_id,attempt_id,basis_key,content_json) VALUES (?,?,?,?,?)').run('retained-grade','alice',workQ.attempts[0]!.id,'old',JSON.stringify({id:'retained-grade',attemptId:workQ.attempts[0]!.id,stale:false}));
    const stem=asset(store,[{}]); reconcileAsset(store,stem.id); const stemQ=readQuestion(store,target(store,stem.fragments[0]!.fragmentId).question_id)!;
    store.db.prepare('INSERT INTO material_answer(id,revision,owner_id,question_id,source,basis_key,content_json) VALUES (?,?,?,?,?,?,?)').run('retained',1,'alice',stemQ.id,'ai','old',JSON.stringify({id:'retained',revision:1,text:'Answer',subpart:null,stale:false}));
    assignDocument(store,{assetId:work.id,documentId:stemQ.documentId!,expectedRevision:1});
    expect(readQuestion(store,stemQ.id)!.answers.some(a=>a.id==='retained')).toBe(true);
    expect(store.listQuestions()).toHaveLength(2);
    expect(readQuestion(store,workQ.id)!.grades.some(g=>g.id==='retained-grade')).toBe(true);
    expect(readQuestion(store,workQ.id)!.unresolved).toContain('result_history_conflict');
    expect(readQuestion(store,stemQ.id)!.unresolved).toContain('result_history_conflict');
    const supplement=asset(store,[{role:'diagram'}],'paper-A',{questionId:stemQ.id}); reconcileAsset(store,supplement.id);
    expect(target(store,supplement.fragments[0]!.fragmentId).question_id).toBe(stemQ.id);
  });
  it('uses dependency-specific bases and invalidates only affected answers, grades and jobs', () => {
    const store=setup(); const page=asset(store,[{}, {role:'student_work',text:'A'}]); reconcileAsset(store,page.id); const q=only(store); const attempt=q.attempts[0]!.id;
    const a=answerBasis(store,q.id); const g=gradeBasis(store,q.id,attempt,[]);
    store.db.prepare('INSERT INTO material_answer(id,revision,owner_id,question_id,source,basis_key,dependencies_json,content_json) VALUES (?,?,?,?,?,?,?,?)').run('answer',1,'alice',q.id,'ai',a.basisKey,JSON.stringify(a.dependencies),JSON.stringify({id:'answer',revision:1,source:'ai',stale:false,subpart:null,text:'Answer'}));
    store.db.prepare('INSERT INTO material_grade(id,owner_id,attempt_id,basis_key,dependencies_json,content_json) VALUES (?,?,?,?,?,?)').run('grade','alice',attempt,g.basisKey,JSON.stringify(g.dependencies),'{}');
    for (const [id,kind,basis] of [['answer-job','answer',a],['grade-job','grade',g]] as const) store.db.prepare('INSERT INTO material_job(id,owner_id,request_id,kind,question_id,basis_key,dependencies_json) VALUES (?,?,?,?,?,?,?)').run(id,'alice',crypto.randomUUID(),kind,q.id,basis.basisKey,JSON.stringify(basis.dependencies));
    store.db.prepare('INSERT INTO material_job(id,owner_id,request_id,kind,question_id,basis_key,dependencies_json,state) VALUES (?,?,?,?,?,?,?,?)').run('failed-grade','alice',crypto.randomUUID(),'grade',q.id,g.basisKey,JSON.stringify(g.dependencies),'failed');
    store.db.prepare('UPDATE material_asset SET hints_json=? WHERE id=?').run('{"label":"renamed"}',page.id); expect(answerBasis(store,q.id)).toEqual(a);
    const fresh=relinkNewAttempt(store,{fragmentIds:[page.fragments[1]!.fragmentId],questionId:q.id,expectedRevision:linkRevision(store)});
    expect(answerBasis(store,q.id)).toEqual(a); expect(gradeBasis(store,q.id,attempt,[]).basisKey).not.toBe(g.basisKey);
    expect(store.db.prepare('SELECT stale FROM material_answer').get()).toEqual({stale:0}); expect(store.db.prepare('SELECT stale FROM material_grade').get()).toEqual({stale:1});
    expect(store.db.prepare('SELECT state FROM material_job WHERE id=?').get('answer-job')).toEqual({state:'queued'}); expect(store.db.prepare('SELECT state FROM material_job WHERE id=?').get('grade-job')).toEqual({state:'stale'});
    expect(store.db.prepare('SELECT state FROM material_job WHERE id=?').get('failed-grade')).toEqual({state:'stale'});
    store.db.prepare('INSERT INTO material_grade(id,owner_id,attempt_id,basis_key,content_json) VALUES (?,?,?,?,?)').run('fallback-grade','alice',fresh.attemptId,'legacy','{}');
    const other=store.createQuestion(); relink(store,{fragmentIds:[page.fragments[0]!.fragmentId],target:{questionId:other.id,attemptId:null},expectedRevision:fresh.revision});
    expect(store.db.prepare('SELECT stale FROM material_answer').get()).toEqual({stale:1}); expect(store.db.prepare('SELECT state FROM material_job WHERE id=?').get('answer-job')).toEqual({state:'stale'});
    expect(dependenciesCurrent(store,a.basisKey,a.dependencies)).toBe(false);
    expect(store.db.prepare('SELECT stale FROM material_grade WHERE id=?').get('fallback-grade')).toEqual({stale:1});
  });
});
