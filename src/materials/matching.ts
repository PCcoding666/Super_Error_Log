import { syncMaterialLearning } from './learning.js';
import { newId } from '../db/connection.js';
import type { CaptureHints, DocumentClues, Extraction, Fragment, QuestionBundle } from './contracts.js';
import type { MaterialStore } from './store.js';
import { currentLink, latestFragments, readQuestion, resolveQuestionId } from './queries.js';

type Asset = { id:string; document_id:string|null; hints_json:string; extraction_json:string|null };
export function materialAsset(store:MaterialStore,id:string):Asset {
  const row=store.db.prepare('SELECT * FROM material_asset WHERE owner_id=? AND id=?').get(store.studentId,id) as Asset|undefined;
  if (!row) throw new Error('asset not found'); return row;
}
function setUnresolved(store:MaterialStore,id:string,reasons:string[]):void {
  store.db.prepare('UPDATE material_question SET unresolved_json=? WHERE owner_id=? AND id=?').run(JSON.stringify([...new Set(reasons)]),store.studentId,id);
}
function documentFor(store:MaterialStore,asset:Asset,clues:DocumentClues,hints:CaptureHints):string|null {
  const explicit=asset.document_id??hints.documentId;
  if (explicit) {
    if (!store.db.prepare('SELECT 1 FROM material_document WHERE owner_id=? AND id=?').get(store.studentId,explicit)) throw new Error('document not found');
    return explicit;
  }
  // A title, label, timestamp, batch, or model confidence never proves document identity.
  const code=clues.printedCode?.trim(); if (!code) return null;
  const matches=(store.db.prepare('SELECT id,clues_json FROM material_document WHERE owner_id=?').all(store.studentId) as {id:string;clues_json:string}[])
    .filter(row=>JSON.parse(row.clues_json).printedCode?.trim()===code);
  if (matches.length>1) return null;
  if (matches.length===1) {
    const known=JSON.parse(matches[0]!.clues_json) as DocumentClues;
    if (known.subject && clues.subject && known.subject!==clues.subject || known.date && clues.date && known.date!==clues.date) return null;
    return matches[0]!.id;
  }
  const id=newId('mdoc'); store.db.prepare('INSERT INTO material_document(id,owner_id,clues_json) VALUES (?,?,?)').run(id,store.studentId,JSON.stringify(clues)); return id;
}
function allFragments(store:MaterialStore,q:QuestionBundle):Fragment[] {
  const rows=store.db.prepare(`SELECT f.content_json FROM material_link_event l JOIN material_fragment f ON f.owner_id=l.owner_id AND f.id=l.fragment_id AND f.revision=l.fragment_revision
    WHERE l.owner_id=? AND l.question_id=? AND NOT EXISTS (SELECT 1 FROM material_link_event n WHERE n.owner_id=l.owner_id AND n.fragment_id=l.fragment_id AND n.revision>l.revision)`).all(store.studentId,q.id) as {content_json:string}[];
  return rows.map(r=>JSON.parse(r.content_json) as Fragment);
}
function compatible(store:MaterialStore,q:QuestionBundle,fragments:Fragment[],explicitAttempt?:string):boolean {
  const existing=allFragments(store,q).filter(f=>!fragments.some(n=>n.fragmentId===f.fragmentId));
  // Stem scope is authoritative. Before a stem arrives, use the substantive
  // provisional material; an unrelated unscoped annotation cannot widen it.
  const stems=existing.filter(f=>f.role==='question');
  const work=existing.filter(f=>f.role==='student_work'||f.role==='correction');
  const scopeEvidence=stems.length?stems:work.length?work:existing.filter(f=>f.role==='diagram'||f.role==='reference_answer');
  for (const f of fragments) {
    if (existing.some(e=>e.role==='question'&&f.role==='question'&&e.subpart===f.subpart&&e.text.trim()!==f.text.trim())) return false;
    if ((f.role==='student_work'||f.role==='correction')&&!explicitAttempt&&existing.some(e=>e.role==='student_work'&&e.assetId!==f.assetId)) return false;
    // Null never covers a named scope (or vice versa). An explicit selected
    // attempt can carry a user-authorized continuation across subparts.
    const scopedMaterial=f.role!=='teacher_mark'&&f.role!=='unknown'||f.subpart!==null;
    if (!explicitAttempt&&existing.length&&scopedMaterial&&!scopeEvidence.some(e=>e.subpart===f.subpart)) return false;
  }
  return true;
}
/** Only an unadopted projection of the currently attached photo references may change question ownership.
 * Independently authored/imported text, AI results, grading, learning and explicit adoption stay protected.
 */
function photoReferenceProvisional(store:MaterialStore,q:QuestionBundle):boolean {
  const fragments=allFragments(store,q);
  if (q.itemId||q.attempts.length||q.grades.length||!fragments.length||fragments.some(f=>f.role!=='reference_answer')) return false;
  if (store.db.prepare('SELECT 1 FROM material_answer_selection WHERE owner_id=? AND question_id=?').get(store.studentId,q.id)) return false;
  const history=store.db.prepare('SELECT source,dependencies_json,content_json FROM material_answer WHERE owner_id=? AND question_id=?').all(store.studentId,q.id) as {source:string;dependencies_json:string;content_json:string}[];
  return history.every(row=>{
    const dependency=JSON.parse(row.dependencies_json) as {version?:number;kind?:string;fragmentId?:string};
    const answer=JSON.parse(row.content_json) as {fragmentIds?:string[]};
    return row.source==='imported'&&dependency.version===2&&dependency.kind==='imported'&&
      answer.fragmentIds?.length===1&&answer.fragmentIds[0]===dependency.fragmentId&&fragments.some(f=>f.fragmentId===dependency.fragmentId);
  });
}
/** Merge only records whose evidence is compatible. Original rows/events/attempts remain available for undo/history. */
export function mergeQuestions(store:MaterialStore,one:string,two:string):string|null {
  one=resolveQuestionId(store,one); two=resolveQuestionId(store,two); if (one===two) return one;
  const a=readQuestion(store,one)!; const b=readQuestion(store,two)!;
  if (a.itemId&&b.itemId&&a.itemId!==b.itemId) { setUnresolved(store,a.id,[...a.unresolved,'learning_conflict']); setUnresolved(store,b.id,[...b.unresolved,'learning_conflict']); return null; }
  const photoLoser=photoReferenceProvisional(store,a)&&b.stem.some(f=>f.role==='question')?a.id:photoReferenceProvisional(store,b)&&a.stem.some(f=>f.role==='question')?b.id:null;
  if (!photoLoser&&(a.answers.length||b.answers.length||a.grades.length||b.grades.length)) {
    setUnresolved(store,a.id,[...a.unresolved,'result_history_conflict']); setUnresolved(store,b.id,[...b.unresolved,'result_history_conflict']); return null;
  }
  if (!compatible(store,a,allFragments(store,b))) return null;
  // A photo-only supplement retains the stem identity and any existing learning/history.
  // Other history-free merges retain the existing learning link, then the earlier identity.
  const order=store.db.prepare('SELECT id FROM material_question WHERE owner_id=? AND id IN (?,?) ORDER BY rowid').all(store.studentId,one,two) as {id:string}[];
  const winner=photoLoser?(photoLoser===a.id?b.id:a.id):a.itemId?a.id:b.itemId?b.id:order[0]!.id; const loser=winner===one?two:one;
  const loserQ=readQuestion(store,loser)!; const winnerQ=readQuestion(store,winner)!;
  const attempts=new Map<string,string>();
  for (const fragment of allFragments(store,loserQ)) {
    const link=currentLink(store,fragment.fragmentId)!;
    let attemptId:string|null=null;
    if (link.attempt_id) {
      if (!attempts.has(link.attempt_id)) attempts.set(link.attempt_id,store.createAttempt(winner).id);
      attemptId=attempts.get(link.attempt_id)!;
    }
    store.linkFragment(fragment.fragmentId,fragment.revision,{questionId:winner,attemptId},link.revision,{reason:'merge',from:loser});
  }
  store.db.prepare("INSERT INTO material_legacy_map(owner_id,source_kind,source_key,question_id,details_json) VALUES (?,'question_alias',?,?,?)").run(store.studentId,loser,winner,JSON.stringify({reason:'compatible_document'}));
  store.db.prepare('UPDATE material_question SET document_id=?,revision=revision+1 WHERE owner_id=? AND id=?').run(winnerQ.documentId??loserQ.documentId,store.studentId,winner);
  setUnresolved(store,winner,[...winnerQ.unresolved,...loserQ.unresolved].filter(r=>r!=='document'&&r!=='association'));
  return winner;
}

/** Strong document evidence plus a unique compatible candidate; ambiguous fragments retain local provisional IDs. */
export function reconcileAsset(store:MaterialStore,assetId:string):{linked:number;pending:string[]} {
  return store.transaction(()=>{
    const asset=materialAsset(store,assetId); const hints=JSON.parse(asset.hints_json) as CaptureHints;
    const extraction=asset.extraction_json?JSON.parse(asset.extraction_json) as Extraction:null;
    const fragments=latestFragments(store,assetId); if (!extraction||!fragments.length) return {linked:0,pending:[]};
    const documentId=documentFor(store,asset,extraction.document,hints);
    if (documentId!==asset.document_id) store.db.prepare('UPDATE material_asset SET document_id=? WHERE owner_id=? AND id=?').run(documentId,store.studentId,assetId);
    let linked=0; const pending=new Set<string>();
    const groups=new Map<string,Fragment[]>();
    for (const fragment of fragments) {
      const key=fragment.number===null?`unknown:${fragment.fragmentId}`:`number:${fragment.number}`;
      groups.set(key,[...(groups.get(key)??[]),fragment]);
    }
    for (const group of groups.values()) {
      if (group.every(f=>currentLink(store,f.fragmentId))) {
        for (const f of group) {
          const old=currentLink(store,f.fragmentId)!;
          if (old.fragment_revision!==f.revision) { store.linkFragment(f.fragmentId,f.revision,old.question_id?{questionId:old.question_id,attemptId:old.attempt_id}:null,old.revision,{reason:'extraction_revision'}); linked++; }
          if (old.question_id && readQuestion(store,old.question_id)!.unresolved.length) pending.add(resolveQuestionId(store,old.question_id));
        }
        continue;
      }
      const first=group[0]!; const existingIds=[...new Set(group.map(f=>currentLink(store,f.fragmentId)?.question_id).filter((id):id is string=>!!id).map(id=>resolveQuestionId(store,id)))];
      let questionId=existingIds.length===1?existingIds[0]:undefined;
      let reason:string|null=null;
      let selectedAttempt: string | undefined;
      if (hints.questionId) {
        const explicit=readQuestion(store,hints.questionId); if (!explicit) throw new Error('question not found');
        if (first.number!==null&&explicit.number!==null&&first.number!==explicit.number) reason='number_conflict';
        else if (documentId&&explicit.documentId&&explicit.documentId!==documentId) reason='document_conflict';
        else { questionId=explicit.id; selectedAttempt=hints.attemptId; }
      }
      if (!questionId && !reason && documentId && first.number!==null) {
        const candidates=store.listQuestions().filter(q=>q.documentId===documentId&&q.number===first.number);
        // Content filtering must never turn two competing same-number candidates into a fake unique match.
        if (candidates.length===1&&compatible(store,candidates[0]!,group,selectedAttempt)) questionId=candidates[0]!.id;
        else if (candidates.length) reason='association';
      }
      if (questionId && selectedAttempt) {
        const attempt=readQuestion(store,questionId)!.attempts.find(a=>a.id===selectedAttempt); if (!attempt) throw new Error('attempt not found');
      }
      if (questionId && !compatible(store,readQuestion(store,questionId)!,group,selectedAttempt)) { questionId=undefined; selectedAttempt=undefined; reason='association'; }
      if (!questionId) questionId=store.createQuestion({documentId,number:first.number,subject:extraction.document.subject,unresolved:reason?[reason]:documentId?[]:['document']}).id;
      if (reason || !documentId && !hints.questionId) { pending.add(questionId); setUnresolved(store,questionId,[...(readQuestion(store,questionId)!.unresolved),reason??'document']); }
      let attemptId=selectedAttempt??null;
      // Local co-occurrence can join fragments from one image. Cross-image continuation requires explicit attempt context.
      if (!attemptId) {
        const local=group.map(f=>currentLink(store,f.fragmentId)).find(l=>l?.question_id===questionId&&l.attempt_id);
        attemptId=local?.attempt_id??null;
        if (!attemptId&&group.some(f=>f.role==='student_work'||f.role==='correction')) attemptId=store.createAttempt(questionId).id;
      }
      for (const f of group) {
        const old=currentLink(store,f.fragmentId);
        // Extraction retries update evidence versions but never undo a manual decision.
        if (old) {
          if (old.fragment_revision!==f.revision) { store.linkFragment(f.fragmentId,f.revision,old.question_id?{questionId:old.question_id,attemptId:old.attempt_id}:null,old.revision,{reason:'extraction_revision'}); linked++; }
          continue;
        }
        store.linkFragment(f.fragmentId,f.revision,{questionId,attemptId:f.role==='student_work'||f.role==='correction'?attemptId:null},0,{reason:reason?'provisional':documentId?'document':'cooccurrence',documentId}); linked++;
      }
    }
    // A locally anchored question needs no document choice. Unknown-document work on
    // another image still has no local stem and remains pending; manual splits are respected.
    const localTargets=new Map<string,Fragment[]>();
    for (const fragment of fragments) {
      const target=currentLink(store,fragment.fragmentId)?.question_id; if (!target) continue;
      const id=resolveQuestionId(store,target); localTargets.set(id,[...(localTargets.get(id)??[]),fragment]);
    }
    for (const [id,local] of localTargets) {
      const question=readQuestion(store,id)!;
      const unresolved=local.some(fragment=>fragment.role==='question')?question.unresolved.filter(reason=>reason!=='document'):question.unresolved;
      if (unresolved.length!==question.unresolved.length) setUnresolved(store,id,unresolved);
      if (unresolved.length) pending.add(id); else pending.delete(id);
    }
    syncMaterialLearning(store);
    return {linked,pending:[...pending]};
  });
}
