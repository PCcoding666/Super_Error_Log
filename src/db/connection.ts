import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config, dbPath, eventsLogPath, packetsDir, uploadsDir } from '../config.js';
import { migrateItemCategoryGrades } from './stageMigration.js';
import { SCHEMA_SQL } from './schema.js';

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(uploadsDir(), { recursive: true });
  fs.mkdirSync(packetsDir(), { recursive: true });
  fs.mkdirSync(path.dirname(eventsLogPath()), { recursive: true });
  db = new DatabaseSync(dbPath());
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA_SQL);
  migrateItemCategoryGrades(db);
  const evidenceCols = db.prepare('PRAGMA table_info(evidence_record)').all() as Array<{ name: string }>;
  if (!evidenceCols.some(c => c.name === 'crop_audit_json')) db.exec('ALTER TABLE evidence_record ADD COLUMN crop_audit_json TEXT');
  const packetCols = db.prepare('PRAGMA table_info(review_packet)').all() as Array<{ name: string }>;
  if (!packetCols.some((c) => c.name === 'generated_at')) {
    db.exec('ALTER TABLE review_packet ADD COLUMN generated_at TEXT');
  }
  // v2.0 T4b：练习包记录做题时段（practiceSlot）。
  if (!packetCols.some((c) => c.name === 'practice_slot')) {
    db.exec('ALTER TABLE review_packet ADD COLUMN practice_slot TEXT');
  }
  // v2.0 T4b-R1：练习包条目冻结建包时的推荐层级与理由（详情不重算）。
  const packetItemCols = db.prepare('PRAGMA table_info(review_packet_item)').all() as Array<{ name: string }>;
  if (!packetItemCols.some((c) => c.name === 'v2_tier')) {
    db.exec('ALTER TABLE review_packet_item ADD COLUMN v2_tier INTEGER');
  }
  if (!packetItemCols.some((c) => c.name === 'v2_reason')) {
    db.exec('ALTER TABLE review_packet_item ADD COLUMN v2_reason TEXT');
  }
  const attemptCols = db.prepare('PRAGMA table_info(review_attempt)').all() as Array<{ name: string }>;
  if (!attemptCols.some((c) => c.name === 'performed_at')) {
    db.exec('ALTER TABLE review_attempt ADD COLUMN performed_at TEXT');
  }
  // v2.0 T4d：提示等级（0 未看提示 / 1 一级 / 2 二级；v2 回传 hint1→1、hint2→2、其余 0）。
  if (!attemptCols.some((c) => c.name === 'hint_level')) {
    db.exec('ALTER TABLE review_attempt ADD COLUMN hint_level INTEGER');
  }
  const diagnosisCols = db.prepare('PRAGMA table_info(error_diagnosis)').all() as Array<{ name: string }>;
  if (!diagnosisCols.some((c) => c.name === 'adopted_ai')) {
    db.exec('ALTER TABLE error_diagnosis ADD COLUMN adopted_ai INTEGER NOT NULL DEFAULT 0');
  }
  // v2.0 T4c：复盘来源（web/v2）、学生原话、AI 归纳。学生原话与 AI 归纳只给学生本人看。
  if (!diagnosisCols.some((c) => c.name === 'source')) {
    db.exec("ALTER TABLE error_diagnosis ADD COLUMN source TEXT NOT NULL DEFAULT 'web'");
  }
  if (!diagnosisCols.some((c) => c.name === 'student_words')) {
    db.exec('ALTER TABLE error_diagnosis ADD COLUMN student_words TEXT');
  }
  if (!diagnosisCols.some((c) => c.name === 'ai_summary')) {
    db.exec('ALTER TABLE error_diagnosis ADD COLUMN ai_summary TEXT');
  }
  // v2.0 T4c-R1：学生确认或改写后的归纳（ai_summary 只存 AI 原文）。
  if (!diagnosisCols.some((c) => c.name === 'confirmed_summary')) {
    db.exec('ALTER TABLE error_diagnosis ADD COLUMN confirmed_summary TEXT');
  }
  // v2.0 T4e-R1：correction_proposal 增加 error 列（失败的模型调用也落库、计入限流）。
  const proposalCols = db.prepare('PRAGMA table_info(correction_proposal)').all() as Array<{ name: string }>;
  if (!proposalCols.some((c) => c.name === 'error')) {
    db.exec('ALTER TABLE correction_proposal ADD COLUMN error TEXT');
  }
  migrateBridgeSchema(db);
  return db;
}

/** v2.0 T3：旧库补齐 evidence_record 与 v2_photo 的桥接列（新表由 SCHEMA_SQL 的 IF NOT EXISTS 创建）。 */
export function migrateBridgeSchema(database: DatabaseSync): void {
  const cols = database.prepare('PRAGMA table_info(evidence_record)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'auto_checks_json')) {
    database.exec('ALTER TABLE evidence_record ADD COLUMN auto_checks_json TEXT');
  }
  if (!cols.some((c) => c.name === 'confidence_badge')) {
    database.exec('ALTER TABLE evidence_record ADD COLUMN confidence_badge TEXT');
  }
  const hasV2Photo = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='v2_photo'").get();
  if (!hasV2Photo) return;
  const photoCols = database.prepare('PRAGMA table_info(v2_photo)').all() as Array<{ name: string }>;
  for (const column of ['batch_id', 'asset_id', 'source_hash']) {
    if (!photoCols.some((c) => c.name === column)) {
      database.exec(`ALTER TABLE v2_photo ADD COLUMN ${column} TEXT`);
    }
  }
  // v2.1a S1：旧库的 mobile_item_link 补 selected_by_student 列（新库由 SCHEMA_SQL 直接带列）。
  const hasLink = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mobile_item_link'").get();
  if (hasLink) {
    const linkCols = database.prepare('PRAGMA table_info(mobile_item_link)').all() as Array<{ name: string }>;
    if (!linkCols.some((c) => c.name === 'selected_by_student')) {
      database.exec('ALTER TABLE mobile_item_link ADD COLUMN selected_by_student INTEGER NOT NULL DEFAULT 0');
    }
  }
}

/** 测试用：关闭并允许换目录重开 */
export function resetDbForTest(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function now(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  const rand = crypto.getRandomValues(new Uint8Array(8));
  const hex = Array.from(rand, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}`;
}
