import { assertTaskWritable } from './practiceTasks.js';
import { getDb } from '../db/connection.js';
import { getPractice } from './practiceService.js';

export interface PracticeProgress {
  cursor: string | null;
  answers: Record<string, { correct: number; completion: string; performed_at: string }>;
  hints: Record<string, number>;
}

export function practiceProgress(packetId: string): PracticeProgress {
  const db = getDb();
  const rows = db.prepare('SELECT item_id, correct, completion, performed_at FROM review_attempt WHERE packet_id = ?').all(packetId) as Array<{item_id: string; correct: number; completion: string; performed_at: string}>;
  const hints = db.prepare('SELECT item_id, hint_level FROM practice_question_progress WHERE packet_id = ?').all(packetId) as Array<{item_id: string; hint_level: number}>;
  const state = db.prepare('SELECT cursor_item FROM practice_progress WHERE packet_id = ?').get(packetId) as {cursor_item: string | null} | undefined;
  return { cursor: state?.cursor_item ?? null, answers: Object.fromEntries(rows.map(r => [r.item_id, r])), hints: Object.fromEntries(hints.map(r => [r.item_id, r.hint_level])) };
}

export function savePracticeCursor(packetId: string, itemId: string): void {
  assertTaskWritable(packetId);
  if (!getPractice(packetId)?.items.some(item => item.id === itemId)) throw new Error('题目不在此练习中');
  getDb().prepare('INSERT INTO practice_progress(packet_id, cursor_item) VALUES (?,?) ON CONFLICT(packet_id) DO UPDATE SET cursor_item = excluded.cursor_item').run(packetId, itemId);
}

export function revealPracticeHint(packetId: string, itemId: string, level: number): void {
  savePracticeCursor(packetId, itemId);
  if (level !== 1 && level !== 2) throw new Error('提示等级无效');
  getDb().prepare('INSERT INTO practice_question_progress(packet_id, item_id, hint_level) VALUES (?,?,?) ON CONFLICT(packet_id,item_id) DO UPDATE SET hint_level = MAX(hint_level, excluded.hint_level)').run(packetId, itemId, level);
}
