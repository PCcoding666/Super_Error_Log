import type { DatabaseSync } from 'node:sqlite';
import { getDb } from '../db/connection.js';
import { JUNIOR_CATALOG } from './juniorCatalog.js';

export const GRADES = ['初一', '初二', '初三'] as const;
export const isGrade = (value: unknown): value is typeof GRADES[number] => GRADES.some(grade => grade === value);
export interface ItemCategory { grade: string; subject: string; chapter: string }

// Existing seed entries include finer knowledge points. They remain evidence, but group under chapters.
const PARENT: Record<string, string> = {
  'quadratic-discriminant': 'quadratic-equations', tangents: 'circles',
  'light-reflection': 'light', 'light-refraction': 'light', gravity: 'forces', elasticity: 'forces', friction: 'forces',
  'fluid-pressure': 'pressure', 'mechanical-efficiency': 'simple-machines', 'joules-law': 'electrical-power',
  'chemical-calculations': 'chemical-equations', 'carbon-dioxide': 'carbon', 'mass-fraction': 'solutions',
  'ph-neutralization': 'acids-bases',
};

export function chapterOf(subject: string, chapter: string | null, tags: string[]): string {
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

/** Snapshot grade once; older AI fields and evidence are never rewritten by classification. */
export function readItemCategory(db: DatabaseSync, studentId: string, itemId: string): ItemCategory | null {
  const item = db.prepare(`SELECT ei.subject,ei.chapter,ei.knowledge_tags,sp.grade,
      (SELECT cs.name FROM mobile_item_link mil JOIN photo_subject_selection ps ON ps.job_id=mil.job_id
       JOIN classification_subject cs ON cs.id=ps.subject_id WHERE mil.item_id=ei.id AND ps.student_id=ei.student_id) AS selected_subject
    FROM error_item ei JOIN student_profile sp ON sp.id=ei.student_id WHERE ei.id=? AND ei.student_id=?`)
    .get(itemId, studentId) as {subject:string|null;chapter:string|null;knowledge_tags:string;grade:string;selected_subject:string|null}|undefined;
  if (!item) return null;
  db.prepare('INSERT OR IGNORE INTO item_category (item_id,student_id,grade) VALUES (?,?,?)')
    .run(itemId, studentId, isGrade(item.grade) ? item.grade : '初三');
  const override = db.prepare('SELECT grade,subject,chapter FROM item_category WHERE item_id=? AND student_id=?')
    .get(itemId, studentId) as {grade:string;subject:string|null;chapter:string|null};
  const subject = override.subject ?? item.selected_subject ?? item.subject?.trim() ?? '未分类';
  // An upload-time subject override cannot reuse another subject's AI chapter.
  const subjectChanged = subject !== item.subject;
  return { grade: override.grade, subject: subject || '未分类',
    chapter: override.chapter ?? chapterOf(subject, subjectChanged ? null : item.chapter, subjectChanged ? [] : JSON.parse(item.knowledge_tags) as string[]) };
}

export function editItemCategory(db: DatabaseSync, studentId: string, itemId: string, input: Record<string, unknown>): string | null {
  const { grade, subject, chapter } = input;
  if (!isGrade(grade)) return '请选择初一、初二或初三。';
  if (typeof subject !== 'string' || !subject.trim() || subject.trim().length > 100) return '请填写学科（1–100 字）。';
  if (typeof chapter !== 'string' || !chapter.trim() || chapter.trim().length > 100) return '请填写章节（1–100 字）。';
  if (!readItemCategory(db, studentId, itemId)) return '题目不存在。';
  db.prepare('UPDATE item_category SET grade=?,subject=?,chapter=?,updated_at=CURRENT_TIMESTAMP WHERE item_id=? AND student_id=?')
    .run(grade, subject.trim(), chapter.trim(), itemId, studentId);
  return null;
}

export function updateStudentGrade(db: DatabaseSync, studentId: string, grade: unknown): boolean {
  if (!isGrade(grade)) return false;
  db.exec('SAVEPOINT change_student_grade');
  try {
    // Preserve all existing grades before changing the default, even for never-opened older questions.
    db.prepare(`INSERT OR IGNORE INTO item_category (item_id,student_id,grade)
      SELECT ei.id,ei.student_id,CASE WHEN sp.grade IN ('初一','初二','初三') THEN sp.grade ELSE '初三' END
      FROM error_item ei JOIN student_profile sp ON sp.id=ei.student_id WHERE ei.student_id=?`).run(studentId);
    const result = db.prepare('UPDATE student_profile SET grade=? WHERE id=?').run(grade, studentId);
    db.exec('RELEASE change_student_grade');
    return Number(result.changes) === 1;
  } catch (error) {
    db.exec('ROLLBACK TO change_student_grade; RELEASE change_student_grade');
    throw error;
  }
}

/** Internal card adapter; authentication remains in the per-student worker/router. */
export function categoryForItem(itemId: string): ItemCategory {
  const db = getDb();
  const owner = db.prepare('SELECT student_id FROM error_item WHERE id=?').get(itemId) as {student_id:string}|undefined;
  if (!owner) throw new Error('题目不存在');
  return readItemCategory(db, owner.student_id, itemId)!;
}
