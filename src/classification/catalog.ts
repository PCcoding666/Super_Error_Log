import type { DatabaseSync } from 'node:sqlite';
import { newId, now } from '../db/connection.js';
import { JUNIOR_CATALOG, JUNIOR_CATALOG_VERSION } from './juniorCatalog.js';
import { DEFAULT_STAGE_ID, type CatalogSubject, type ClassificationCatalog } from './types.js';

/** Initialize once per student/stage. Reading must never undo later catalog edits or merges. */
export function ensureJuniorCatalog(database: DatabaseSync, studentId: string): void {
  const existing = database.prepare('SELECT 1 FROM classification_catalog WHERE student_id=? AND stage_id=?')
    .get(studentId, DEFAULT_STAGE_ID);
  if (existing) return;
  if (!database.prepare('SELECT 1 FROM student_profile WHERE id=?').get(studentId)) {
    throw new Error('学生档案不存在');
  }

  database.exec('SAVEPOINT seed_classification_catalog');
  try {
    const timestamp = now();
    database.prepare('INSERT INTO classification_catalog (student_id,stage_id,version,created_at) VALUES (?,?,?,?)')
      .run(studentId, DEFAULT_STAGE_ID, JUNIOR_CATALOG_VERSION, timestamp);
    const insertSubject = database.prepare(`INSERT INTO classification_subject
      (id,student_id,stage_id,standard_key,name,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`);
    const insertTopic = database.prepare(`INSERT INTO classification_topic
      (id,subject_id,standard_key,name,aliases_json,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`);
    JUNIOR_CATALOG.forEach((subject, subjectIndex) => {
      const subjectId = newId('csu');
      insertSubject.run(subjectId, studentId, DEFAULT_STAGE_ID, subject.key, subject.name, subjectIndex, timestamp, timestamp);
      subject.topics.forEach((topic, topicIndex) => {
        insertTopic.run(newId('ctp'), subjectId, topic.key, topic.name, JSON.stringify(topic.aliases ?? []), topicIndex, timestamp, timestamp);
      });
    });
    database.exec('RELEASE seed_classification_catalog');
  } catch (error) {
    database.exec('ROLLBACK TO seed_classification_catalog; RELEASE seed_classification_catalog');
    throw error;
  }
}

/** Read one student's stage catalog. Future stages are explicit and never fall back to junior. */
export function readCatalog(database: DatabaseSync, studentId: string, stageId = DEFAULT_STAGE_ID): ClassificationCatalog {
  if (stageId === DEFAULT_STAGE_ID) ensureJuniorCatalog(database, studentId);
  const stage = database.prepare(`SELECT s.id,s.name,c.version FROM classification_catalog c
    JOIN learning_stage s ON s.id=c.stage_id WHERE c.student_id=? AND c.stage_id=?`).get(studentId, stageId) as
    { id: string; name: string; version: number } | undefined;
  if (!stage) throw new Error('该学段尚未建立分类目录');
  const subjects = database.prepare(`SELECT id,standard_key AS standardKey,name FROM classification_subject
    WHERE student_id=? AND stage_id=? ORDER BY sort_order,id`).all(studentId, stageId) as unknown as
    Array<Omit<CatalogSubject, 'topics'>>;
  const topicQuery = database.prepare(`SELECT id,standard_key AS standardKey,name,aliases_json FROM classification_topic
    WHERE subject_id=? ORDER BY sort_order,id`);
  return {
    stage: { id: stage.id, name: stage.name },
    version: stage.version,
    subjects: subjects.map(subject => ({
      ...subject,
      topics: (topicQuery.all(subject.id) as Array<{ id: string; standardKey: string | null; name: string; aliases_json: string }>)
        .map(({ aliases_json, ...topic }) => ({ ...topic, aliases: JSON.parse(aliases_json) as string[] })),
    })),
  };
}
