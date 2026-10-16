import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { classificationDb, classificationItem, classificationStudent } from '../helpers/classification.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';

let db: DatabaseSync;
beforeEach(() => { db = classificationDb(); classificationStudent(db, 'a'); classificationItem(db, 'a', 'one'); });
afterEach(() => db.close());

it('adds item categories without rewriting original evidence, and migration is repeatable', () => {
  const before = db.prepare('SELECT * FROM error_item').get();
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='item_category'").get();
  expect(exists).toBeDefined();
  db.exec(SCHEMA_SQL);
  expect(db.prepare('SELECT * FROM error_item').get()).toEqual(before);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

import { chapterOf, editItemCategory, readItemCategory, updateStudentGrade } from '../../src/classification/itemCategories.js';

it('groups fine knowledge points under a chapter without using a fourth filter', () => {
  expect(chapterOf('数学', '一元二次方程的根的判别式', [])).toBe('一元二次方程');
  expect(chapterOf('数学', '', ['根的判别式', '求根公式'])).toBe('一元二次方程');
  expect(chapterOf('数学', '二次函数', ['根的判别式'])).toBe('二次函数');
  expect(chapterOf('数学', '', ['看不清'])).toBe('未分类');
});

it('snapshots existing grades on settings change and uses the new default for new questions', () => {
  expect(updateStudentGrade(db, 'a', '初二')).toBe(true);
  expect(readItemCategory(db, 'a', 'one')?.grade).toBe('初三');
  classificationItem(db, 'a', 'two');
  expect(readItemCategory(db, 'a', 'two')?.grade).toBe('初二');
  expect(updateStudentGrade(db, 'a', 'invalid')).toBe(false);
});

it('isolates manual changes by owner and keeps them after the AI evidence is updated', () => {
  classificationStudent(db, 'b');
  expect(readItemCategory(db, 'b', 'one')).toBeNull();
  expect(editItemCategory(db, 'b', 'one', {grade:'初一',subject:'数学',chapter:'有理数'})).toBe('题目不存在。');
  expect(editItemCategory(db, 'a', 'one', {grade:'初二',subject:'物理',chapter:'力'})).toBeNull();
  db.prepare("UPDATE error_item SET subject='化学',chapter='化学方程式' WHERE id='one'").run();
  expect(readItemCategory(db, 'a', 'one')).toEqual({grade:'初二',subject:'物理',chapter:'力'});
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(() => db.prepare("INSERT INTO item_category(item_id,student_id,grade) VALUES ('one','b','初三')").run()).toThrow();
});

import { renderToStaticMarkup } from 'react-dom/server';
import { CategoryEditPage } from '../../src/web/views/items.js';
it('lets an unclassified question keep its chapter while the student edits only grade', () => {
  const item = {id:'one',shortId:null,subject:'数学',grade:'初三',chapter:'未分类',knowledgeTags:[],questionExcerpt:null,badge:'ok' as const,status:'needs_recheck' as const,cropUrl:'',jobId:''};
  const html = renderToStaticMarkup(CategoryEditPage({item}));
  expect(/<input[^>]*id="category-chapter"[^>]*>/.exec(html)?.[0]).toContain('value="未分类"');
  expect(editItemCategory(db, 'a', 'one', {grade:'初二',subject:'数学',chapter:'未分类'})).toBeNull();
  expect(readItemCategory(db, 'a', 'one')).toEqual({grade:'初二',subject:'数学',chapter:'未分类'});
});
