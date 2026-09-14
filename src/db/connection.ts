import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config, dbPath, eventsLogPath, packetsDir, uploadsDir } from '../config.js';
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
  const evidenceCols = db.prepare('PRAGMA table_info(evidence_record)').all() as Array<{ name: string }>;
  if (!evidenceCols.some(c => c.name === 'crop_audit_json')) db.exec('ALTER TABLE evidence_record ADD COLUMN crop_audit_json TEXT');
  const packetCols = db.prepare('PRAGMA table_info(review_packet)').all() as Array<{ name: string }>;
  if (!packetCols.some((c) => c.name === 'generated_at')) {
    db.exec('ALTER TABLE review_packet ADD COLUMN generated_at TEXT');
  }
  const attemptCols = db.prepare('PRAGMA table_info(review_attempt)').all() as Array<{ name: string }>;
  if (!attemptCols.some((c) => c.name === 'performed_at')) {
    db.exec('ALTER TABLE review_attempt ADD COLUMN performed_at TEXT');
  }
  return db;
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
