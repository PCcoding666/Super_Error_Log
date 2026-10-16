import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { classificationDb, classificationItem, classificationStudent } from '../helpers/classification.js';

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));

function database(sql?: string): DatabaseSync {
  const db = classificationDb(sql);
  databases.push(db);
  return db;
}

function subject(db: DatabaseSync, studentId = 'a', id = 'math', stageId = 'junior'): void {
  db.prepare('INSERT OR IGNORE INTO classification_catalog (student_id,stage_id,version) VALUES (?,?,1)').run(studentId, stageId);
  db.prepare('INSERT INTO classification_subject (id,student_id,stage_id,name) VALUES (?,?,?,?)').run(id, studentId, stageId, id);
}

function classified(db: DatabaseSync): void {
  classificationStudent(db, 'a');
  classificationItem(db, 'a', 'item');
  subject(db);
  db.prepare('INSERT INTO item_classification (item_id,student_id,stage_id,subject_id) VALUES (?,?,?,?)').run('item', 'a', 'junior', 'math');
}

describe('classification schema: additive migration and integrity', () => {
  it('creates the classification structure and default junior stage', () => {
    const db = database();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    expect(tables).toEqual(expect.arrayContaining([
      'learning_stage', 'classification_catalog', 'classification_subject', 'classification_topic',
      'item_classification', 'item_classification_topic', 'photo_subject_selection', 'classification_batch', 'classification_task',
    ]));
    expect(db.prepare('SELECT name FROM learning_stage WHERE id=?').get('junior')).toEqual({ name: '初中' });
  });

  it('upgrades the actual pre-feature schema twice without changing old item/evidence/state', () => {
    const oldSql = readFileSync(new URL('../fixtures/classification-before.sql', import.meta.url), 'utf8');
    const db = database(oldSql);
    classificationStudent(db, 'a');
    classificationItem(db, 'a', 'item');
    db.prepare('INSERT INTO evidence_record (item_id,content_json,updated_at) VALUES (?,?,?)').run('item', '{"synthetic":true}', '2026-10-16');
    const item = db.prepare('SELECT * FROM error_item').get();
    const evidence = db.prepare('SELECT * FROM evidence_record').get();
    db.exec(SCHEMA_SQL);
    db.exec(SCHEMA_SQL);
    expect(db.prepare('SELECT * FROM error_item').get()).toEqual(item);
    expect(db.prepare('SELECT * FROM evidence_record').get()).toEqual(evidence);
    expect(db.prepare('SELECT count(*) AS n FROM item_classification').get()).toEqual({ n: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('stores separate AI origins and human confirmation without changing learning status', () => {
    const db = database();
    classified(db);
    db.prepare(`UPDATE item_classification SET subject_source='ai', knowledge_source='manual',
      subject_confirmed=1, knowledge_confirmed=1, status='classified', input_revision=3 WHERE item_id='item'`).run();
    db.exec(SCHEMA_SQL);
    expect(db.prepare('SELECT subject_source,knowledge_source,subject_confirmed,knowledge_confirmed,input_revision FROM item_classification').get())
      .toEqual({ subject_source: 'ai', knowledge_source: 'manual', subject_confirmed: 1, knowledge_confirmed: 1, input_revision: 3 });
    expect(db.prepare('SELECT status FROM error_item').get()).toEqual({ status: 'needs_recheck' });
  });

  it('rejects another student’s subject and another student’s item', () => {
    const db = database();
    classified(db);
    classificationStudent(db, 'b');
    subject(db, 'b', 'b-math');
    expect(() => db.prepare("UPDATE item_classification SET subject_id='b-math' WHERE item_id='item'").run()).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare("UPDATE item_classification SET student_id='b',subject_id='b-math' WHERE item_id='item'").run()).toThrow(/FOREIGN KEY/);
  });

  it('rejects a subject belonging to another stage', () => {
    const db = database();
    classified(db);
    db.prepare('INSERT INTO learning_stage (id,name) VALUES (?,?)').run('senior', '高中');
    subject(db, 'a', 'senior-math', 'senior');
    expect(() => db.prepare("UPDATE item_classification SET subject_id='senior-math' WHERE item_id='item'").run()).toThrow(/FOREIGN KEY/);
  });

  it('allows multiple matching topics, rejecting mixed subjects and duplicate links', () => {
    const db = database();
    classified(db);
    subject(db, 'a', 'physics');
    db.exec(`INSERT INTO classification_topic (id,subject_id,name) VALUES ('t1','math','方程'),('t2','math','不等式'),('t3','physics','力学')`);
    const insert = db.prepare('INSERT INTO item_classification_topic (item_id,subject_id,topic_id) VALUES (?,?,?)');
    insert.run('item', 'math', 't1');
    insert.run('item', 'math', 't2');
    expect(() => insert.run('item', 'math', 't3')).toThrow(/FOREIGN KEY/);
    expect(() => insert.run('item', 'physics', 't3')).toThrow(/FOREIGN KEY/);
    expect(() => insert.run('item', 'math', 't1')).toThrow(/UNIQUE/);
    expect(db.prepare('SELECT count(*) AS n FROM item_classification_topic').get()).toEqual({ n: 2 });
  });

  it.each([
    "status='unknown'", "subject_source='imported'", 'subject_confirmed=2', 'knowledge_confirmed=-1', 'input_revision=-1',
  ])('rejects invalid classification metadata: %s', assignment => {
    const db = database();
    classified(db);
    expect(() => db.exec(`UPDATE item_classification SET ${assignment}`)).toThrow(/CHECK/);
  });

  it.each([
    ['learning_stage', 'id', 'name', "'新学段'"],
    ['classification_subject', 'id', 'student_id,stage_id,name', "'a','junior','新增学科'"],
    ['classification_topic', 'id', 'subject_id,name', "'math','新增知识点'"],
    ['item_classification', 'item_id', 'student_id', "'a'"],
    ['classification_batch', 'id', 'student_id', "'a'"],
  ])('rejects missing and NULL identities in %s', (table, key, columns, values) => {
    const db = database();
    classified(db);
    expect(() => db.exec(`INSERT INTO ${table} (${columns}) VALUES (${values})`)).toThrow(/NOT NULL/);
    expect(() => db.exec(`INSERT INTO ${table} (${key},${columns}) VALUES (NULL,${values})`)).toThrow(/NOT NULL/);
  });

  it('keeps associations when a subject/topic display name changes', () => {
    const db = database();
    classified(db);
    db.exec("INSERT INTO classification_topic (id,subject_id,name) VALUES ('t','math','方程')");
    db.exec("INSERT INTO item_classification_topic (item_id,subject_id,topic_id) VALUES ('item','math','t')");
    db.exec("UPDATE classification_subject SET name='我的数学' WHERE id='math'");
    db.exec("UPDATE classification_topic SET name='方程训练' WHERE id='t'");
    expect(db.prepare(`SELECT s.name AS subject,t.name AS topic FROM item_classification c
      JOIN classification_subject s ON s.id=c.subject_id JOIN item_classification_topic l ON l.item_id=c.item_id
      JOIN classification_topic t ON t.id=l.topic_id`).get()).toEqual({ subject: '我的数学', topic: '方程训练' });
  });

  it('persists a manual photo subject before any extracted question exists', () => {
    const db = database();
    classificationStudent(db, 'a');
    subject(db);
    db.exec("INSERT INTO v2_photo (job_id,student_id,registered_at) VALUES ('photo','a','2026-10-16')");
    db.exec("INSERT INTO photo_subject_selection (job_id,student_id,subject_id) VALUES ('photo','a','math')");
    db.exec(SCHEMA_SQL);
    expect(db.prepare('SELECT job_id,student_id,stage_id,subject_id FROM photo_subject_selection').get())
      .toEqual({ job_id: 'photo', student_id: 'a', stage_id: 'junior', subject_id: 'math' });
    expect(db.prepare('SELECT count(*) AS n FROM error_item').get()).toEqual({ n: 0 });
    db.exec("DELETE FROM v2_photo WHERE job_id='photo'");
    expect(db.prepare('SELECT count(*) AS n FROM photo_subject_selection').get()).toEqual({ n: 0 });
  });

  it('rejects a photo subject from another student or stage and a NULL photo identity', () => {
    const db = database();
    classificationStudent(db, 'a');
    classificationStudent(db, 'b');
    subject(db);
    subject(db, 'b', 'b-math');
    db.exec("INSERT INTO learning_stage (id,name) VALUES ('senior','高中')");
    subject(db, 'a', 'senior-math', 'senior');
    db.exec("INSERT INTO v2_photo (job_id,student_id,registered_at) VALUES ('photo','a','2026-10-16')");
    const insert = db.prepare('INSERT INTO photo_subject_selection (job_id,student_id,subject_id) VALUES (?,?,?)');
    expect(() => insert.run('photo', 'a', 'b-math')).toThrow(/FOREIGN KEY/);
    expect(() => insert.run('photo', 'b', 'b-math')).toThrow(/FOREIGN KEY/);
    expect(() => insert.run('photo', 'a', 'senior-math')).toThrow(/FOREIGN KEY/);
    expect(() => insert.run(null, 'a', 'math')).toThrow(/NOT NULL/);
  });

  it('persists batch retries and prevents tasks borrowing a different student’s item', () => {
    const db = database();
    classified(db);
    classificationStudent(db, 'b');
    classificationItem(db, 'b', 'b-item');
    db.exec("INSERT INTO classification_batch (id,student_id) VALUES ('batch','a')");
    db.exec("INSERT INTO classification_task (batch_id,item_id,student_id) VALUES ('batch','item','a')");
    expect(() => db.exec("INSERT INTO classification_task (batch_id,item_id,student_id) VALUES ('batch','b-item','a')")).toThrow(/FOREIGN KEY/);
    expect(() => db.exec("INSERT INTO classification_task (batch_id,item_id,student_id) VALUES ('batch','b-item','b')")).toThrow(/FOREIGN KEY/);
    db.exec("UPDATE classification_task SET status='failed',attempts=1,error='synthetic timeout' WHERE item_id='item'");
    db.exec(SCHEMA_SQL);
    expect(db.prepare('SELECT status,attempts,error FROM classification_task').get())
      .toEqual({ status: 'failed', attempts: 1, error: 'synthetic timeout' });
  });

  it('cascades item removal into classifications, topic links and history tasks', () => {
    const db = database();
    classified(db);
    db.exec("INSERT INTO classification_topic (id,subject_id,name) VALUES ('t','math','方程')");
    db.exec("INSERT INTO item_classification_topic (item_id,subject_id,topic_id) VALUES ('item','math','t')");
    db.exec("INSERT INTO classification_batch (id,student_id) VALUES ('batch','a')");
    db.exec("INSERT INTO classification_task (batch_id,item_id,student_id) VALUES ('batch','item','a')");
    db.exec("DELETE FROM error_item WHERE id='item'");
    for (const table of ['item_classification', 'item_classification_topic', 'classification_task']) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('allows the existing wipe order to remove profiles after clearing items', () => {
    const db = database();
    classified(db);
    db.exec("INSERT INTO classification_batch (id,student_id) VALUES ('batch','a')");
    db.exec("INSERT INTO classification_task (batch_id,item_id,student_id) VALUES ('batch','item','a')");
    db.exec('DELETE FROM error_item; DELETE FROM source_asset; DELETE FROM source_batch; DELETE FROM student_profile;');
    for (const table of ['classification_catalog', 'classification_subject', 'classification_batch', 'classification_task']) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });
});
