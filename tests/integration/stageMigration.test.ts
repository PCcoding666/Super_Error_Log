import { afterEach, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { migrateItemCategoryGrades } from '../../src/db/stageMigration.js';
import { classificationDb, classificationItem, classificationStudent } from '../helpers/classification.js';

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));

it('maps stored year grades to 初中 and keeps the question row', () => {
  const db = classificationDb();
  databases.push(db);
  classificationStudent(db, 'a');
  db.prepare("UPDATE student_profile SET grade='初二'").run();
  classificationItem(db, 'a', 'one');
  const item = db.prepare('SELECT * FROM error_item').get();
  db.exec('DROP TABLE item_category');
  db.exec(`CREATE TABLE item_category (
    item_id TEXT NOT NULL PRIMARY KEY,
    student_id TEXT NOT NULL,
    grade TEXT NOT NULL CHECK (grade IN ('初一','初二','初三')),
    subject TEXT,
    chapter TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (item_id,student_id) REFERENCES error_item(id,student_id) ON DELETE CASCADE
  )`);
  db.prepare("INSERT INTO item_category (item_id,student_id,grade,subject,chapter) VALUES ('one','a','初三','数学','一元二次方程')").run();
  expect(() => db.prepare("UPDATE item_category SET grade='高中'").run()).toThrow(/CHECK/);
  migrateItemCategoryGrades(db);
  migrateItemCategoryGrades(db);
  expect(db.prepare('SELECT grade,subject,chapter FROM item_category').get()).toEqual({ grade: '初中', subject: '数学', chapter: '一元二次方程' });
  expect(db.prepare('SELECT grade FROM student_profile').get()).toEqual({ grade: '初中' });
  db.prepare("UPDATE item_category SET grade='高中'").run();
  expect(db.prepare('SELECT grade FROM item_category').get()).toEqual({ grade: '高中' });
  expect(db.prepare('SELECT * FROM error_item').get()).toEqual(item);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(() => db.prepare("UPDATE item_category SET grade='初一'").run()).toThrow(/CHECK/);
});

it('does not rebuild a database that already stores stages', () => {
  const db = classificationDb();
  databases.push(db);
  classificationStudent(db, 'a');
  db.prepare("UPDATE student_profile SET grade='高中'").run();
  const before = db.prepare("SELECT sql FROM sqlite_master WHERE name='item_category'").get();
  migrateItemCategoryGrades(db);
  expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='item_category'").get()).toEqual(before);
  expect(db.prepare('SELECT grade FROM student_profile').get()).toEqual({ grade: '高中' });
});
