import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { ensureJuniorCatalog, readCatalog } from '../../src/classification/catalog.js';
import { classificationDb, classificationItem, classificationStudent } from '../helpers/classification.js';

let db: DatabaseSync;
beforeEach(() => {
  db = classificationDb();
  classificationStudent(db, 'a');
});
afterEach(() => db.close());

describe('student classification catalog', () => {
  it('provides default junior subjects and common junior topics with stable keys and aliases', () => {
    const catalog = readCatalog(db, 'a');
    expect(catalog.stage).toEqual({ id: 'junior', name: '初中' });
    expect(catalog.version).toBe(1);
    expect(catalog.subjects.map(s => s.name)).toEqual(['数学', '物理', '化学']);
    expect(catalog.subjects.map(s => s.standardKey)).toEqual(['math', 'physics', 'chemistry']);
    const [math, physics, chemistry] = catalog.subjects;
    expect(math?.topics).toEqual(expect.arrayContaining([expect.objectContaining({ standardKey: 'pythagorean-theorem', name: '勾股定理', aliases: expect.arrayContaining(['勾股定理应用']) })]));
    expect(physics?.topics).toEqual(expect.arrayContaining([expect.objectContaining({ name: '二力平衡' })]));
    expect(chemistry?.topics).toEqual(expect.arrayContaining([expect.objectContaining({ name: '质量守恒定律' })]));
    for (const subject of catalog.subjects) {
      expect(subject.topics.length).toBeGreaterThanOrEqual(20);
      const keys = subject.topics.map(t => t.standardKey);
      expect(new Set(keys).size).toBe(keys.length);
      const labels = subject.topics.flatMap(t => [t.name, ...t.aliases]);
      expect(new Set(labels).size).toBe(labels.length);
    }
    expect(physics?.topics.some(t => t.name === '牛顿第二定律')).toBe(false);
  });

  it('is repeatable without rewriting legacy question content or learning status', () => {
    classificationItem(db, 'a', 'item');
    const before = db.prepare('SELECT * FROM error_item').get();
    const first = readCatalog(db, 'a');
    ensureJuniorCatalog(db, 'a');
    db.exec(SCHEMA_SQL);
    expect(readCatalog(db, 'a')).toEqual(first);
    expect(db.prepare('SELECT * FROM error_item').get()).toEqual(before);
    expect(db.prepare('SELECT count(*) AS n FROM item_classification').get()).toEqual({ n: 0 });
  });

  it('preserves renamed subjects/topics and does not recreate removed or merged topics on a new read', () => {
    const before = readCatalog(db, 'a');
    const math = before.subjects[0]!;
    const renamed = math.topics[0]!;
    const removed = math.topics[1]!;
    db.prepare('UPDATE classification_subject SET name=? WHERE id=?').run('我的数学', math.id);
    db.prepare('UPDATE classification_topic SET name=? WHERE id=?').run('我的知识点', renamed.id);
    db.prepare('DELETE FROM classification_topic WHERE id=?').run(removed.id);
    db.exec(SCHEMA_SQL);
    const after = readCatalog(db, 'a').subjects[0]!;
    expect(after).toMatchObject({ id: math.id, standardKey: 'math', name: '我的数学' });
    expect(after.topics.find(t => t.id === renamed.id)?.name).toBe('我的知识点');
    expect(after.topics.some(t => t.standardKey === removed.standardKey)).toBe(false);
    expect(after.topics.length).toBe(math.topics.length - 1);
  });

  it('gives each student a separate editable catalog', () => {
    classificationStudent(db, 'b');
    const a = readCatalog(db, 'a');
    const b = readCatalog(db, 'b');
    const aIds = new Set(a.subjects.flatMap(s => [s.id, ...s.topics.map(t => t.id)]));
    expect(b.subjects.flatMap(s => [s.id, ...s.topics.map(t => t.id)]).some(id => aIds.has(id))).toBe(false);
    db.prepare('UPDATE classification_subject SET name=? WHERE id=?').run('甲的数学', a.subjects[0]!.id);
    expect(readCatalog(db, 'b')).toEqual(b);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('does not manufacture a student or catalog for an unknown owner', () => {
    expect(() => readCatalog(db, 'unknown')).toThrow(/学生/);
    expect(db.prepare('SELECT count(*) AS n FROM classification_catalog').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM classification_subject').get()).toEqual({ n: 0 });
  });

  it('does not reuse junior topics for another stage', () => {
    readCatalog(db, 'a');
    db.prepare('INSERT INTO learning_stage (id,name) VALUES (?,?)').run('senior', '高中');
    expect(() => readCatalog(db, 'a', 'senior')).toThrow(/学段/);
    db.exec("INSERT INTO classification_catalog (student_id,stage_id,version) VALUES ('a','senior',1)");
    db.exec("INSERT INTO classification_subject (id,student_id,stage_id,name) VALUES ('senior-math','a','senior','数学')");
    expect(readCatalog(db, 'a', 'senior')).toMatchObject({
      stage: { id: 'senior', name: '高中' }, subjects: [{ id: 'senior-math', name: '数学', topics: [] }],
    });
  });

  it('rolls back a partial seed and lets the next attempt initialize completely', () => {
    db.exec(`CREATE TRIGGER reject_chemistry BEFORE INSERT ON classification_subject
      WHEN NEW.standard_key='chemistry' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`);
    expect(() => ensureJuniorCatalog(db, 'a')).toThrow(/synthetic failure/);
    for (const table of ['classification_catalog', 'classification_subject', 'classification_topic']) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    db.exec('DROP TRIGGER reject_chemistry');
    expect(readCatalog(db, 'a').subjects).toHaveLength(3);
  });

  it('composes with an existing transaction without committing its caller’s work', () => {
    db.exec('BEGIN');
    ensureJuniorCatalog(db, 'a');
    expect(db.isTransaction).toBe(true);
    expect(readCatalog(db, 'a').subjects).toHaveLength(3);
    db.exec('ROLLBACK');
    expect(db.prepare('SELECT count(*) AS n FROM classification_catalog').get()).toEqual({ n: 0 });
  });
});
