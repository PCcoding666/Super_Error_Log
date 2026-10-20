import { expect, it } from 'vitest';
import { getDb, newId, now } from '../../src/db/connection.js';
import { ensureStudentProfile } from '../../src/services/studentService.js';
import { MaterialStore } from '../../src/materials/store.js';
import type { CaptureHints, Extraction, Fragment } from '../../src/materials/contracts.js';
import { reconcileAsset } from '../../src/materials/matching.js';
import { assignDocument, assetLinkRevision, linkRevision, relink, undoLink } from '../../src/materials/links.js';
import { answerHistory, readQuestion } from '../../src/materials/queries.js';
import { saveManualAnswer, selectAnswerBasis, selectedAnswerIds } from '../../src/materials/answers.js';
import { materialPracticeEligible, setQuestionIncluded } from '../../src/materials/learning.js';
import { directCorrection } from '../../src/v2/correctionService.js';
import { getLearningContext } from '../../src/learning/sources.js';

function page(store: MaterialStore, role: Fragment['role'], subject: string | null, printedCode: string | null, hints: CaptureHints = {}, check: Fragment['check'] = 'passed') {
  const id = newId('ast'), capture = store.createCapture(crypto.randomUUID());
  store.db.prepare('INSERT INTO source_batch(id,student_id,created_at) VALUES (?,?,?)').run(id, store.studentId, now());
  store.db.prepare('INSERT INTO source_asset(id,batch_id,filename,mime,size,content_hash,storage_path,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id,id,'synthetic.jpg','image/jpeg',1,id,'/synthetic.jpg',now());
  store.db.prepare('INSERT INTO material_asset(id,owner_id,capture_id,source_asset_id,hints_json) VALUES (?,?,?,?,?)').run(id,store.studentId,capture.id,id,JSON.stringify(hints));
  const fragment: Fragment = { assetId:id,fragmentId:newId('mfr'),revision:1,sourceHash:id,role,text:role==='question'?'Solve x+1=3':'x=3',box:{x:0,y:0,width:1,height:1},number:'12',subpart:null,page:1,order:0,requiresDiagram:false,check,uncertainties:[] };
  const extraction: Extraction = {assetId:id,revision:1,document:{title:null,subject,printedCode,date:null,page:1},fragments:[fragment],warnings:[],runs:[]};
  store.putFragment(fragment);
  store.db.prepare('UPDATE material_asset SET extraction_json=? WHERE id=?').run(JSON.stringify(extraction),id);
  return {id,fragment,extraction};
}
function questionFor(store: MaterialStore, fragment: Fragment) {
  const row=store.db.prepare('SELECT question_id FROM material_link_event WHERE fragment_id=? ORDER BY revision DESC LIMIT 1').get(fragment.fragmentId) as {question_id:string};
  return readQuestion(store,row.question_id)!;
}

it.each(['document','context','assign-card','assign-stem'] as const)('completes a genuinely unclassified answer card through %s with reversible classification and retained history', mode => {
  const store=new MaterialStore(getDb(),ensureStudentProfile().id),code=newId('paper');
  const card=page(store,'student_work',null,mode==='document'||mode==='assign-stem'?code:null);
  reconcileAsset(store,card.id);const original=questionFor(store,card.fragment),attempt=original.attempts[0]!.id;
  expect(original.subject).toBeNull();expect(original.missing).toContain('stem');
  const answer=saveManualAnswer(store,{questionId:original.id,subpart:null,text:'x=2',claimedSource:'Teacher',expectedRevision:original.revision});
  selectAnswerBasis(store,original.id,[answer.id],readQuestion(store,original.id)!.revision);
  // Inclusion intent can precede the missing stem without manufacturing an item.
  expect(setQuestionIncluded(store,original.id,true,readQuestion(store,original.id)!.revision).itemId).toBeNull();
  const stem=page(store,'question','数学',mode==='document'||mode==='assign-card'?code:null,mode==='context'?{questionId:original.id}:{});
  reconcileAsset(store,stem.id);
  let assignment: ReturnType<typeof assignDocument> | undefined;
  if(mode.startsWith('assign')) {
    const moving=mode==='assign-card'?card:stem;
    const documentId=(mode==='assign-card'?questionFor(store,stem.fragment):readQuestion(store,original.id))!.documentId!;
    assignment=assignDocument(store,{assetId:moving.id,documentId,expectedRevision:assetLinkRevision(store,moving.id)});
    expect(()=>assignDocument(store,{assetId:moving.id,documentId,expectedRevision:1})).toThrow(/更新/);
  }
  const joined=readQuestion(store,original.id)!;
  expect(joined.id).toBe(original.id);expect(joined.subject).toBe('数学');expect(joined.missing).toEqual([]);expect(joined.unresolved).toEqual([]);
  expect(joined.attempts[0]!.id).toBe(attempt);expect(joined.attempts[0]!.fragments).toEqual([card.fragment]);
  expect(joined.answers[0]).toMatchObject({id:answer.id,revision:2,text:'x=2',stale:false});expect(selectedAnswerIds(store,joined.id)).toEqual([answer.id]);
  expect(answerHistory(store,joined.id).map(h=>h.answer.revision)).toEqual([2,1]);
  expect(materialPracticeEligible(store,joined.id)).toBe(true);expect(getLearningContext(joined.itemId!)!.context.subject).toBe('数学');
  expect(store.db.prepare('SELECT subject FROM error_item WHERE id=?').get(joined.itemId!)).toEqual({subject:'数学'});
  expect(store.db.prepare('SELECT subject FROM material_question WHERE id=?').get(original.id)).toEqual({subject:null});
  if(assignment) undoLink(store,assignment[0]!.id,linkRevision(store));
  else {
    const elsewhere=store.createQuestion({number:'12'}).id,revision=linkRevision(store);
    const moved=relink(store,{fragmentIds:[stem.fragment.fragmentId],target:{questionId:elsewhere,attemptId:null},expectedRevision:revision});
    expect(readQuestion(store,original.id)!.subject).toBeNull();expect(materialPracticeEligible(store,original.id)).toBe(false);expect(getLearningContext(joined.itemId!)).toBeNull();
    expect(store.db.prepare('SELECT subject FROM error_item WHERE id=?').get(joined.itemId!)).toEqual({subject:null});
    expect(()=>undoLink(store,moved.id,revision)).toThrow(/更新/);
    undoLink(store,moved.id,linkRevision(store));
    expect(readQuestion(store,original.id)!.subject).toBe('数学');expect(materialPracticeEligible(store,original.id)).toBe(true);
    // Re-adding known evidence does not renew the first-completion manual answer.
    expect(readQuestion(store,original.id)!.answers[0]!.stale).toBe(true);
    return;
  }
  const undone=readQuestion(store,original.id)!;expect(undone.subject).toBeNull();expect(undone.attempts[0]!.id).toBe(attempt);
  expect(materialPracticeEligible(store,original.id)).toBe(false);expect(getLearningContext(joined.itemId!)).toBeNull();
    expect(store.db.prepare('SELECT subject FROM error_item WHERE id=?').get(joined.itemId!)).toEqual({subject:null});
  expect(undone.answers[0]!.stale).toBe(true);expect(answerHistory(store,original.id)).toHaveLength(2);
});

it.each(['passed','low'] as const)('derives missing subject from actual current %s stem evidence only and preserves explicit authority', check => {
  const store=new MaterialStore(getDb(),ensureStudentProfile().id);
  const card=page(store,'student_work',null,null);reconcileAsset(store,card.id);const q=questionFor(store,card.fragment);
  const stem=page(store,'question','数学',null,{questionId:q.id},check);reconcileAsset(store,stem.id);
  const item=setQuestionIncluded(store,q.id,true,readQuestion(store,q.id)!.revision).itemId!;
  expect(readQuestion(store,q.id)!.subject).toBe('数学');expect(materialPracticeEligible(store,q.id)).toBe(true);
  expect(directCorrection(item,{revision:getLearningContext(item)!.revision,changes:[{field:'questionText',before:stem.fragment.text,after:'Solve x + 1 = 3'}]}).ok).toBe(true);
  expect(readQuestion(store,q.id)!.subject).toBe('数学');
  expect(store.db.prepare('SELECT subject FROM material_question WHERE id=?').get(q.id)).toEqual({subject:null});
  const conflict=page(store,'question','物理',null,{questionId:q.id});
  conflict.fragment.text='Solve x + 1 = 3';store.putFragment({...conflict.fragment,revision:2});
  reconcileAsset(store,conflict.id);
  expect(readQuestion(store,q.id)!.subject).toBeNull();expect(materialPracticeEligible(store,q.id)).toBe(false);expect(getLearningContext(item)).toBeNull();
  store.linkFragment(conflict.fragment.fragmentId,2,null);
  expect(readQuestion(store,q.id)!.subject).toBe('数学');
  // A stale/foreign source, or unrelated extraction fragment, cannot confer classification.
  store.db.prepare('UPDATE source_asset SET content_hash=? WHERE id=?').run('changed',stem.id);
  expect(readQuestion(store,q.id)!.subject).toBeNull();
  store.db.prepare('UPDATE source_asset SET content_hash=? WHERE id=?').run(stem.id,stem.id);
  store.db.prepare('UPDATE material_asset SET extraction_json=? WHERE id=?').run(JSON.stringify({...stem.extraction,fragments:[]}),stem.id);
  expect(readQuestion(store,q.id)!.subject).toBeNull();
  store.db.prepare('UPDATE material_asset SET extraction_json=? WHERE id=?').run(JSON.stringify(stem.extraction),stem.id);
  const other=newId('stu');store.db.prepare('INSERT INTO student_profile(id,nickname,created_at) VALUES (?,?,?)').run(other,'Synthetic other',now());
  store.db.prepare('UPDATE source_batch SET student_id=? WHERE id=?').run(other,stem.id);
  expect(readQuestion(store,q.id)!.subject).toBeNull();
  store.db.prepare('UPDATE source_batch SET student_id=? WHERE id=?').run(store.studentId,stem.id);
  expect(directCorrection(item,{revision:getLearningContext(item)!.revision,changes:[{field:'subject',before:'数学',after:'化学'}]}).ok).toBe(true);
  expect(store.db.prepare('SELECT subject FROM material_question WHERE id=?').get(q.id)).toEqual({subject:'化学'});
  expect(readQuestion(store,q.id)!.subject).toBe('化学');
  store.db.prepare('UPDATE material_question SET subject=? WHERE id=?').run('unknown-model-subject',q.id);
  expect(readQuestion(store,q.id)!.subject).toBe('unknown-model-subject');expect(materialPracticeEligible(store,q.id)).toBe(false);
});

it.each([
  {subject:null,check:'passed'},{subject:'math',check:'passed'},
  {subject:'数学',check:'unchecked'},{subject:'数学',check:'failed'},
] as const)('does not derive unsupported or unchecked classification: $subject/$check', ({subject,check})=>{
  const store=new MaterialStore(getDb(),ensureStudentProfile().id);
  const card=page(store,'student_work',null,null);reconcileAsset(store,card.id);const q=questionFor(store,card.fragment);
  const stem=page(store,'question',subject,null,{questionId:q.id},check);reconcileAsset(store,stem.id);
  const item=setQuestionIncluded(store,q.id,true,readQuestion(store,q.id)!.revision).itemId!;
  expect(readQuestion(store,q.id)!.subject).toBeNull();expect(materialPracticeEligible(store,q.id)).toBe(false);expect(getLearningContext(item)).toBeNull();
});
