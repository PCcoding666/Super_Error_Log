import type { DatabaseSync } from 'node:sqlite';
import { getDb } from '../db/connection.js';
import { JUNIOR_CATALOG } from './juniorCatalog.js';
import { isStage, STAGE_REQUIRED_MESSAGE } from './stages.js';

export { STAGE_REQUIRED_MESSAGE, STAGES, isStage, stageChoices, type Stage } from './stages.js';
export interface ItemCategory { grade: string; subject: string; chapter: string }

// Existing seed entries include finer knowledge points. They remain evidence, but group under chapters.
const PARENT: Record<string, string> = {
  'quadratic-discriminant': 'quadratic-equations', tangents: 'circles',
  'light-reflection': 'light', 'light-refraction': 'light', gravity: 'forces', elasticity: 'forces', friction: 'forces',
  'fluid-pressure': 'pressure', 'mechanical-efficiency': 'simple-machines', 'joules-law': 'electrical-power',
  'chemical-calculations': 'chemical-equations', 'carbon-dioxide': 'carbon', 'mass-fraction': 'solutions',
  'ph-neutralization': 'acids-bases',
};

/**
 * 初中 chapters are normalized against the junior catalog.
 * 高中 keeps the model's chapter text; knowledge tags are not rewritten onto junior chapters.
 */
export function chapterOf(subject: string, chapter: string | null, tags: string[], stage?: string | null): string {
  if (stage === '高中') {
    const text = (chapter ?? '').trim();
    return text ? text.slice(0, 100) : '未分类';
  }
  const topics = JUNIOR_CATALOG.find(entry => entry.name === subject)?.topics ?? [];
  const label = (key: string, name: string): string => {
    const parent = PARENT[key];
    return parent ? topics.find(topic => topic.key === parent)?.name ?? (parent === 'light' ? '光现象' : name) : name;
  };
  // Prefer an explicit chapter, then recognizable tags on old records with no chapter.
  for (const value of [chapter ?? '', ...tags]) {
    const text = value.trim();
    if (!text) continue;
    const matches = topics.flatMap(topic => [topic.name, ...('aliases' in topic ? topic.aliases ?? [] : [])]
      .filter(alias => text.includes(alias)).map(alias => ({ topic, length: alias.length })));
    matches.sort((a, b) => b.length - a.length);
    if (matches[0]) return label(matches[0].topic.key, matches[0].topic.name);
    if (/判别式|求根公式|韦达定理/.test(text) && subject === '数学') return '一元二次方程';
    if (value === chapter) return text.slice(0, 100);
  }
  return '未分类';
}

/** Snapshot stage once; older AI fields and evidence are never rewritten by classification. */
export function readItemCategory(db: DatabaseSync, studentId: string, itemId: string): ItemCategory | null {
  const item = db.prepare(`SELECT ei.subject,ei.chapter,ei.knowledge_tags,sp.grade,
      (SELECT cs.name FROM mobile_item_link mil JOIN photo_subject_selection ps ON ps.job_id=mil.job_id
       JOIN classification_subject cs ON cs.id=ps.subject_id WHERE mil.item_id=ei.id AND ps.student_id=ei.student_id) AS selected_subject
    FROM error_item ei JOIN student_profile sp ON sp.id=ei.student_id WHERE ei.id=? AND ei.student_id=?`)
    .get(itemId, studentId) as {subject:string|null;chapter:string|null;knowledge_tags:string;grade:string;selected_subject:string|null}|undefined;
  if (!item) return null;
  db.prepare('INSERT OR IGNORE INTO item_category (item_id,student_id,grade) VALUES (?,?,?)')
    .run(itemId, studentId, isStage(item.grade) ? item.grade : '初中');
  const override = db.prepare('SELECT grade,subject,chapter FROM item_category WHERE item_id=? AND student_id=?')
    .get(itemId, studentId) as {grade:string;subject:string|null;chapter:string|null};
  const subject = override.subject ?? item.selected_subject ?? item.subject?.trim() ?? '未分类';
  // An upload-time subject override cannot reuse another subject's AI chapter.
  const subjectChanged = subject !== item.subject;
  return { grade: override.grade, subject: subject || '未分类',
    chapter: override.chapter ?? chapterOf(subject, subjectChanged ? null : item.chapter, subjectChanged ? [] : JSON.parse(item.knowledge_tags) as string[], override.grade) };
}

export function editItemCategory(db: DatabaseSync, studentId: string, itemId: string, input: Record<string, unknown>): string | null {
  const { grade, subject, chapter } = input;
  if (!isStage(grade)) return STAGE_REQUIRED_MESSAGE;
  if (typeof subject !== 'string' || !subject.trim() || subject.trim().length > 100) return '请填写学科（1–100 字）。';
  if (typeof chapter !== 'string' || !chapter.trim() || chapter.trim().length > 100) return '请填写章节（1–100 字）。';
  const current = readItemCategory(db, studentId, itemId);
  if (!current) return '题目不存在。';
  const stored = db.prepare('SELECT subject,chapter FROM item_category WHERE item_id=? AND student_id=?')
    .get(itemId, studentId) as {subject:string|null;chapter:string|null};
  // The form is prefilled with computed values. Only a field the student actually changed becomes a manual
  // override; an untouched prefilled chapter stays computed, so a stage change can reclassify it.
  const keep = (value: string, shown: string, override: string | null): string | null =>
    override === null && value === shown ? null : value;
  db.prepare('UPDATE item_category SET grade=?,subject=?,chapter=?,updated_at=CURRENT_TIMESTAMP WHERE item_id=? AND student_id=?')
    .run(grade, keep(subject.trim(), current.subject, stored.subject), keep(chapter.trim(), current.chapter, stored.chapter), itemId, studentId);
  return null;
}

export function updateStudentGrade(db: DatabaseSync, studentId: string, grade: unknown): boolean {
  if (!isStage(grade)) return false;
  db.exec('SAVEPOINT change_student_grade');
  try {
    // Preserve all existing stages before changing the default, even for never-opened older questions.
    db.prepare(`INSERT OR IGNORE INTO item_category (item_id,student_id,grade)
      SELECT ei.id,ei.student_id,CASE WHEN sp.grade IN ('初中','高中') THEN sp.grade ELSE '初中' END
      FROM error_item ei JOIN student_profile sp ON sp.id=ei.student_id WHERE ei.student_id=?`).run(studentId);
    const result = db.prepare('UPDATE student_profile SET grade=? WHERE id=?').run(grade, studentId);
    db.exec('RELEASE change_student_grade');
    return Number(result.changes) === 1;
  } catch (error) {
    db.exec('ROLLBACK TO change_student_grade; RELEASE change_student_grade');
    throw error;
  }
}

/** New accounts choose 初中/高中 once before the notebook. Accounts that already have questions or photos,
 * or that chose before (here or in settings), are never asked; their stage stays as it is. */
export function stageChoiceNeeded(db: DatabaseSync, studentId: string): boolean {
  if (db.prepare('SELECT 1 FROM student_stage_choice WHERE student_id=?').get(studentId)) return false;
  if (db.prepare('SELECT 1 FROM error_item WHERE student_id=? LIMIT 1').get(studentId)) return false;
  // Any earlier photo counts as prior activity: new material uploads, and legacy uploads that are still
  // processing, failed, or had no question selected (v2_photo has no error_item yet).
  const has = (table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (has('material_asset') && db.prepare('SELECT 1 FROM material_asset WHERE owner_id=? LIMIT 1').get(studentId)) return false;
  if (has('v2_photo') && db.prepare('SELECT 1 FROM v2_photo WHERE student_id=? LIMIT 1').get(studentId)) return false;
  return true;
}

/** Records an explicit stage choice. Existing questions keep their stage (see updateStudentGrade). */
export function chooseStudentStage(db: DatabaseSync, studentId: string, grade: unknown): boolean {
  if (!updateStudentGrade(db, studentId, grade)) return false;
  db.prepare('INSERT INTO student_stage_choice (student_id) VALUES (?) ON CONFLICT(student_id) DO UPDATE SET chosen_at=CURRENT_TIMESTAMP').run(studentId);
  return true;
}

/** Internal card adapter; authentication remains in the per-student worker/router. */
export function categoryForItem(itemId: string): ItemCategory {
  const db = getDb();
  const owner = db.prepare('SELECT student_id FROM error_item WHERE id=?').get(itemId) as {student_id:string}|undefined;
  if (!owner) throw new Error('题目不存在');
  return readItemCategory(db, owner.student_id, itemId)!;
}
