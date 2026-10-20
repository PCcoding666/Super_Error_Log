import type { DatabaseSync } from 'node:sqlite';
import { newId } from '../db/connection.js';
import { validateEvidence, type Evidence } from '../ai/evidence.js';
import type { Fragment, MaterialRole, ReferenceAnswer } from './contracts.js';
import { MaterialStore } from './store.js';

type LegacyRow = {
  id: string; student_id: string; asset_id: string; batch_id: string;
  content_hash: string; content_json: string | null; evidence_revision: number | null;
  verified: number | null; confidence_badge: string | null;
  job_id: string | null; question_id: string | null; question_revision: number | null;
};

/** Read existing DB evidence only. No file access, model calls, or changes to legacy rows. */
export function backfillLegacyMaterials(db: DatabaseSync): { mapped: number } {
  const rows=db.prepare(`SELECT i.id,i.student_id,i.asset_id,i.batch_id,a.content_hash,
    e.content_json,e.revision AS evidence_revision,e.verified,e.confidence_badge,
    m.job_id,m.question_id,m.question_revision FROM error_item i
    JOIN source_asset a ON a.id=i.asset_id JOIN source_batch b ON b.id=a.batch_id AND b.student_id=i.student_id
    LEFT JOIN evidence_record e ON e.item_id=i.id LEFT JOIN mobile_item_link m ON m.item_id=i.id
    WHERE NOT EXISTS (SELECT 1 FROM material_legacy_map l WHERE l.owner_id=i.student_id AND l.source_kind='error_item' AND l.source_key=i.id)
    ORDER BY i.created_at,i.id`).all() as LegacyRow[];
  let mapped=0;
  for (const row of rows) {
    const store=new MaterialStore(db,row.student_id);
    store.transaction(()=>{
      // Serialize with a concurrent/repeated startup before allocating any new IDs.
      if (db.prepare("SELECT 1 FROM material_legacy_map WHERE owner_id=? AND source_kind='error_item' AND source_key=?").get(row.student_id,row.id)) return;
      const capture=store.createCapture(`legacy-batch:${row.batch_id}`);
      db.prepare('UPDATE material_capture SET source_batch_id=? WHERE owner_id=? AND id=?').run(row.batch_id,row.student_id,capture.id);
      let asset=db.prepare('SELECT id FROM material_asset WHERE owner_id=? AND source_asset_id=?').get(row.student_id,row.asset_id) as {id:string}|undefined;
      if (!asset) {
        asset={id:row.asset_id};
        db.prepare('INSERT INTO material_asset(id,owner_id,capture_id,source_asset_id,status) VALUES (?,?,?,?,?)').run(asset.id,row.student_id,capture.id,row.asset_id,'legacy');
      }
      let evidence:Evidence|null=null;
      let issue:string|null=null;
      if (row.content_json===null) issue='legacy_evidence_missing';
      else { try { evidence=validateEvidence(JSON.parse(row.content_json)); } catch { issue='legacy_evidence_invalid'; } }
      const question=store.createQuestion({number:evidence?.questionNumber,subject:evidence?.subject,tags:evidence?.knowledgeTags,unresolved:issue?[issue]:[]});
      db.prepare('INSERT INTO material_item_link(owner_id,question_id,item_id) VALUES (?,?,?)').run(row.student_id,question.id,row.id);
      db.prepare('INSERT INTO material_legacy_map(owner_id,source_kind,source_key,question_id,details_json) VALUES (?,?,?,?,?)')
        .run(row.student_id,'error_item',row.id,question.id,JSON.stringify({itemId:row.id,sourceAssetId:row.asset_id,evidenceRevision:row.evidence_revision,
          mobile:row.job_id?{jobId:row.job_id,questionId:row.question_id,revision:row.question_revision}:null,issue}));
      if (evidence) mapEvidence(store,row,asset.id,question.id,evidence);
      mapped++;
    });
  }
  return {mapped};
}

function mapEvidence(store:MaterialStore,row:LegacyRow,assetId:string,questionId:string,evidence:Evidence):void {
  const revision=row.evidence_revision??1;
  // A historical successful AI call is not a passed content check. Preserve low-confidence warnings.
  const check:Fragment['check']=row.confidence_badge==='low'?'low':row.verified===1?'passed':'unchecked';
  let order=0;
  const put=(role:MaterialRole,text:string,box:Fragment['box'],uncertainties:string[]=[])=>{
    const fragment:Fragment={assetId,fragmentId:newId('mfr'),revision,box,sourceHash:row.content_hash,
      role,text,number:evidence.questionNumber,subpart:null,page:null,order:order++,requiresDiagram:role==='question'&&evidence.requiresDiagram,
      check:uncertainties.length && check==='passed'?'unchecked':check,uncertainties:[...evidence.uncertainties,...uncertainties]};
    store.putFragment(fragment); return fragment;
  };
  const stem=put('question',evidence.questionText,evidence.questionRegion);
  store.linkFragment(stem.fragmentId,revision,{questionId,attemptId:null},0,{source:'legacy',itemId:row.id});
  for (const region of evidence.regions.filter(r=>r.kind==='diagram')) {
    const diagram=put('diagram','',region.box);
    store.linkFragment(diagram.fragmentId,revision,{questionId,attemptId:null},0,{source:'legacy',regionId:region.id});
  }
  const hasAttempt=evidence.observations.some(o=>o.kind==='student_work'||o.kind==='correction');
  const attempt=hasAttempt?store.createAttempt(questionId):null;
  for (const observation of evidence.observations) {
    const region=evidence.regions.find(r=>r.id===observation.regionId);
    const fragment=put(observation.kind==='teacher_note'?'teacher_mark':observation.kind,observation.text,region?.box??evidence.questionRegion,
      region?[]:['legacy_observation_region_missing']);
    const attemptId=observation.kind==='student_work'||observation.kind==='correction'?attempt!.id:null;
    store.linkFragment(fragment.fragmentId,revision,{questionId,attemptId},0,{source:'legacy',observationId:observation.id});
    if (observation.kind==='reference_answer') {
      const answer:ReferenceAnswer={id:newId('man'),questionId,subpart:null,revision:1,source:'imported',text:observation.text,
        claimedSource:null,fragmentIds:[fragment.fragmentId],basisKey:store.getQuestion(questionId)!.basisKey,stale:false,run:null};
      store.db.prepare('INSERT INTO material_answer(id,revision,owner_id,question_id,source,basis_key,dependencies_json,content_json) VALUES (?,?,?,?,?,?,?,?)')
        .run(answer.id,answer.revision,store.studentId,questionId,answer.source,answer.basisKey,JSON.stringify([{fragmentId:fragment.fragmentId,revision}]),JSON.stringify(answer));
    }
  }
}
