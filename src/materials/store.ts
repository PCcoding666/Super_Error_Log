import { syncMaterialLearning } from './learning.js';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { newId } from '../db/connection.js';
import { validateBox } from '../media/images.js';
import { answersConflict, projectImportedFragment } from './answers.js';
import { invalidateLinkDependencies, resolveQuestionId } from './queries.js';
import type { Fragment, Grade, LinkChange, LinkTarget, QuestionBundle, ReferenceAnswer } from './contracts.js';

type QuestionRow = { id: string; document_id: string | null; revision: number; number: string | null; subject: string | null; tags_json: string; unresolved_json: string };
type LinkRow = { question_id: string | null; attempt_id: string | null; fragment_revision: number; revision: number };

/** Construct only with the server-owned profile in the current student's worker database. */
export class MaterialStore {
  constructor(readonly db: DatabaseSync, readonly studentId: string) {
    if (!db.prepare('SELECT 1 FROM student_profile WHERE id=?').get(studentId)) throw new Error('student not found');
    db.prepare('INSERT OR IGNORE INTO material_workspace(owner_id,draft_namespace) VALUES (?,?)').run(studentId,newId('draft'));
  }

  transaction<T>(fn: () => T): T {
    if (fn.constructor.name === 'AsyncFunction') throw new Error('material transactions must be synchronous');
    const savepoint = newId('material_tx');
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('material transactions must be synchronous');
      this.db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${savepoint}`); this.db.exec(`RELEASE ${savepoint}`); throw error;
    }
  }

  getWorkspace(): { draftNamespace: string } {
    const row = this.db.prepare('SELECT draft_namespace FROM material_workspace WHERE owner_id=?').get(this.studentId) as {draft_namespace:string};
    return {draftNamespace:row.draft_namespace};
  }

  createCapture(requestId: string): { id: string } {
    if (!requestId.trim()) throw new Error('capture request ID required');
    this.db.prepare('INSERT OR IGNORE INTO material_capture(id,owner_id,request_id) VALUES (?,?,?)').run(newId('cap'),this.studentId,requestId);
    return this.db.prepare('SELECT id FROM material_capture WHERE owner_id=? AND request_id=?').get(this.studentId,requestId) as {id:string};
  }

  createQuestion(input: { documentId?: string | null; number?: string | null; subject?: string | null; tags?: string[]; unresolved?: string[] } = {}): {id:string} {
    const id=newId('mqu');
    this.db.prepare('INSERT INTO material_question(id,owner_id,document_id,number,subject,tags_json,unresolved_json) VALUES (?,?,?,?,?,?,?)')
      .run(id,this.studentId,input.documentId??null,input.number??null,input.subject??null,JSON.stringify(input.tags??[]),JSON.stringify(input.unresolved??[]));
    return {id};
  }

  createAttempt(questionId: string): {id:string} {
    const id=newId('mat');
    this.db.prepare('INSERT INTO material_attempt(id,owner_id,question_id) VALUES (?,?,?)').run(id,this.studentId,questionId);
    return {id};
  }

  putFragment(fragment: Fragment): void {
    validateBox(fragment.box);
    const source=this.db.prepare(`SELECT s.content_hash FROM material_asset a JOIN source_asset s ON s.id=a.source_asset_id
      WHERE a.owner_id=? AND a.id=?`).get(this.studentId,fragment.assetId) as {content_hash:string}|undefined;
    if (!source || source.content_hash!==fragment.sourceHash) throw new Error('fragment source mismatch');
    if (!Number.isInteger(fragment.revision) || fragment.revision < 1) throw new Error('invalid fragment revision');
    const existing = this.db.prepare('SELECT content_json FROM material_fragment WHERE owner_id=? AND id=? AND revision=?').get(this.studentId,fragment.fragmentId,fragment.revision) as {content_json:string}|undefined;
    const content=JSON.stringify(fragment);
    if (existing) { if (existing.content_json!==content) throw new Error('fragment revision already exists'); return; }
    const previous=this.db.prepare('SELECT owner_id,asset_id FROM material_fragment WHERE id=? LIMIT 1').get(fragment.fragmentId) as {owner_id:string;asset_id:string}|undefined;
    if (previous && (previous.owner_id!==this.studentId || previous.asset_id!==fragment.assetId)) throw new Error('fragment owner/source mismatch');
    this.db.prepare('INSERT INTO material_fragment(id,revision,owner_id,asset_id,content_json) VALUES (?,?,?,?,?)').run(fragment.fragmentId,fragment.revision,this.studentId,fragment.assetId,content);
  }

  linkFragment(fragmentId: string, fragmentRevision: number, target: LinkTarget | null, expectedLinkRevision?: number, basis: Record<string,unknown> = {}): LinkChange {
    return this.transaction(()=>{
      const old=this.db.prepare('SELECT question_id,attempt_id,fragment_revision,revision FROM material_link_event WHERE owner_id=? AND fragment_id=? ORDER BY revision DESC LIMIT 1').get(this.studentId,fragmentId) as LinkRow|undefined;
      if (expectedLinkRevision!==undefined && expectedLinkRevision!==(old?.revision??0)) throw new Error('link revision conflict');
      const id=newId('mlk'); const revision=(old?.revision??0)+1;
      this.db.prepare(`INSERT INTO material_link_event(id,owner_id,fragment_id,fragment_revision,revision,question_id,attempt_id,before_question_id,before_attempt_id,before_fragment_revision,basis_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id,this.studentId,fragmentId,fragmentRevision,revision,target?.questionId??null,target?.attemptId??null,old?.question_id??null,old?.attempt_id??null,old?.fragment_revision??null,JSON.stringify(basis));
      for (const questionId of new Set([old?.question_id,target?.questionId].filter((v):v is string=>!!v))) {
        this.db.prepare('UPDATE material_question SET revision=revision+1 WHERE owner_id=? AND id=?').run(this.studentId,questionId);
      }
      for (const attemptId of new Set([old?.attempt_id,target?.attemptId].filter((v):v is string=>!!v))) {
        this.db.prepare('UPDATE material_attempt SET revision=revision+1 WHERE owner_id=? AND id=?').run(this.studentId,attemptId);
      }
      const source=this.db.prepare('SELECT content_json FROM material_fragment WHERE owner_id=? AND id=? AND revision=?').get(this.studentId,fragmentId,fragmentRevision) as {content_json:string};
      invalidateLinkDependencies(this,[...new Set([old?.question_id,target?.questionId].filter((v):v is string=>!!v))],JSON.parse(source.content_json),[...new Set([old?.attempt_id,target?.attemptId].filter((v):v is string=>!!v))]);
      projectImportedFragment(this,fragmentId);
      syncMaterialLearning(this);
      return {id,questionId:target?.questionId??old?.question_id??'',revision};
    });
  }

  listQuestions(): QuestionBundle[] {
    const rows=this.db.prepare(`SELECT q.id FROM material_question q WHERE q.owner_id=? AND NOT EXISTS (SELECT 1 FROM material_legacy_map m WHERE m.owner_id=q.owner_id AND m.source_kind='question_alias' AND m.source_key=q.id) ORDER BY q.created_at,q.id`).all(this.studentId) as {id:string}[];
    return rows.map(row=>this.getQuestion(row.id)!);
  }

  getQuestion(id: string): QuestionBundle | null {
    id=resolveQuestionId(this,id);
    const row=this.db.prepare('SELECT * FROM material_question WHERE owner_id=? AND id=?').get(this.studentId,id) as QuestionRow|undefined;
    if (!row) return null;
    const links=this.db.prepare(`SELECT f.content_json,l.attempt_id,l.revision AS link_revision FROM material_link_event l
      JOIN material_fragment f ON f.owner_id=l.owner_id AND f.id=l.fragment_id AND f.revision=l.fragment_revision
      WHERE l.owner_id=? AND l.question_id=? AND NOT EXISTS (
        SELECT 1 FROM material_link_event newer WHERE newer.owner_id=l.owner_id AND newer.fragment_id=l.fragment_id AND newer.revision>l.revision
      ) ORDER BY f.id`).all(this.studentId,id) as {content_json:string;attempt_id:string|null;link_revision:number}[];
    const fragments=links.map(l=>({...l,fragment:JSON.parse(l.content_json) as Fragment}));
    const order=(a:Fragment,b:Fragment)=>(a.page??Number.MAX_SAFE_INTEGER)-(b.page??Number.MAX_SAFE_INTEGER)||a.order-b.order||a.fragmentId.localeCompare(b.fragmentId);
    const stem=fragments.filter(f=>f.fragment.role==='question'||f.fragment.role==='diagram').map(f=>f.fragment).sort(order);
    const attempts=(this.db.prepare('SELECT id,revision FROM material_attempt WHERE owner_id=? AND question_id=? ORDER BY created_at,id').all(this.studentId,id) as {id:string;revision:number}[])
      .map(a=>({...a,fragments:fragments.filter(f=>f.attempt_id===a.id).map(f=>f.fragment).sort(order)}));
    const answers=this.db.prepare(`SELECT a.content_json,a.stale FROM material_answer a WHERE owner_id=? AND question_id=? AND NOT EXISTS (
      SELECT 1 FROM material_answer n WHERE n.owner_id=a.owner_id AND n.id=a.id AND n.revision>a.revision) ORDER BY id`).all(this.studentId,id) as {content_json:string;stale:number}[];
    const grades=this.db.prepare(`SELECT g.content_json,g.stale FROM material_grade g JOIN material_attempt a ON a.owner_id=g.owner_id AND a.id=g.attempt_id WHERE g.owner_id=? AND a.question_id=? AND NOT EXISTS (
      SELECT 1 FROM material_grade n WHERE n.owner_id=g.owner_id AND n.id=g.id AND n.revision>g.revision) ORDER BY g.id`).all(this.studentId,id) as {content_json:string;stale:number}[];
    const missing:QuestionBundle['missing']=[];
    if (!stem.some(f=>f.role==='question'&&f.text.trim())) missing.push('stem');
    if (stem.some(f=>f.requiresDiagram)&&!stem.some(f=>f.role==='diagram')) missing.push('diagram');
    if (!attempts.some(a=>a.fragments.some(f=>f.role==='student_work'))) missing.push('work');
    const item=this.db.prepare('SELECT item_id FROM material_item_link WHERE owner_id=? AND question_id=?').get(this.studentId,id) as {item_id:string}|undefined;
    const parsedAnswers=answers.map(a=>({...JSON.parse(a.content_json),stale:!!a.stale}) as ReferenceAnswer);
    // Deterministic dependency digest: presentation labels and capture order never participate.
    const basisKey=createHash('sha256').update(JSON.stringify({
      fragments:fragments.map(f=>({id:f.fragment.fragmentId,revision:f.fragment.revision,source:f.fragment.sourceHash,box:f.fragment.box,link:f.link_revision,attempt:f.attempt_id})),
      answers:parsedAnswers.map(a=>({id:a.id,revision:a.revision,basisKey:a.basisKey})),
    })).digest('hex');
    return {id,documentId:row.document_id,revision:row.revision,basisKey,number:row.number,subject:row.subject,tags:JSON.parse(row.tags_json),
      stem,attempts,teacherMarks:fragments.filter(f=>f.fragment.role==='teacher_mark').map(f=>f.fragment).sort(order),
      answers:parsedAnswers,grades:grades.map(g=>({...JSON.parse(g.content_json),stale:!!g.stale}) as Grade),
      missing,unresolved:JSON.parse(row.unresolved_json),answerConflict:answersConflict(parsedAnswers),itemId:item?.item_id??null};
  }
}
