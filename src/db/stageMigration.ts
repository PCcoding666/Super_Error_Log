import type { DatabaseSync } from 'node:sqlite';
import { ITEM_CATEGORY_COLUMNS_SQL } from './classificationSchema.js';

/**
 * Rebuild item_category when it still checks year grades, and map stored years onto a stage.
 * Copies every row. Does not rewrite error_item, evidence, or learning state.
 * 初一/初二/初三 and any other non-stage value become 初中. 高中 is kept.
 */
export function migrateItemCategoryGrades(database: DatabaseSync): void {
  const profile = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='student_profile'").get();
  const normalizeProfile = (): void => {
    if (profile) database.exec("UPDATE student_profile SET grade='初中' WHERE grade NOT IN ('初中','高中')");
  };
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='item_category'").get() as { sql?: string } | undefined;
  if (!row?.sql?.includes("'初一'")) {
    normalizeProfile();
    return;
  }
  if (database.isTransaction) throw new Error('学段迁移必须在事务外执行');
  const foreignKeys = database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
  database.exec('PRAGMA foreign_keys = OFF');
  database.exec('SAVEPOINT migrate_item_category_grades');
  try {
    normalizeProfile();
    database.exec(`CREATE TABLE item_category__rebuild (${ITEM_CATEGORY_COLUMNS_SQL})`);
    database.exec(`INSERT INTO item_category__rebuild (item_id, student_id, grade, subject, chapter, updated_at)
      SELECT item_id, student_id, CASE WHEN grade='高中' THEN '高中' ELSE '初中' END, subject, chapter, updated_at
      FROM item_category`);
    database.exec('DROP TABLE item_category');
    database.exec('ALTER TABLE item_category__rebuild RENAME TO item_category');
    database.exec('RELEASE migrate_item_category_grades');
  } catch (error) {
    database.exec('ROLLBACK TO migrate_item_category_grades');
    database.exec('RELEASE migrate_item_category_grades');
    throw error;
  } finally {
    if (foreignKeys.foreign_keys) database.exec('PRAGMA foreign_keys = ON');
  }
}
