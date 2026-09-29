/**
 * v2.0 T4a：学生设置（设计稿 §13 第 4 条）。
 * practiceSlot：默认做题时段（1–20 字，默认"本周内"）；paperLocation：原卷通常所在（school/home/varies，默认 varies）。
 */
import { getDb, now } from '../db/connection.js';
import { audit } from '../services/eventLog.js';
import { ensureStudentProfile } from '../services/studentService.js';

export type PaperLocation = 'school' | 'home' | 'varies';

export interface V2Settings {
  practiceSlot: string;
  paperLocation: PaperLocation;
}

export const DEFAULT_V2_SETTINGS: V2Settings = { practiceSlot: '本周内', paperLocation: 'varies' };

export function getV2Settings(): V2Settings {
  const student = ensureStudentProfile();
  const row = getDb().prepare('SELECT practice_slot, paper_location FROM v2_setting WHERE student_id = ?').get(student.id) as
    { practice_slot: string; paper_location: PaperLocation } | undefined;
  if (!row) return { ...DEFAULT_V2_SETTINGS };
  return { practiceSlot: row.practice_slot, paperLocation: row.paper_location };
}

export function updateV2Settings(input: unknown): { ok: true; settings: V2Settings } | { ok: false; message: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, message: '请求正文不合法。' };
  const body = input as Record<string, unknown>;
  const practiceSlot = body.practiceSlot;
  if (typeof practiceSlot !== 'string' || practiceSlot.length < 1 || practiceSlot.length > 20) {
    return { ok: false, message: 'practiceSlot 必须是 1–20 字的字符串。' };
  }
  const paperLocation = body.paperLocation;
  if (paperLocation !== 'school' && paperLocation !== 'home' && paperLocation !== 'varies') {
    return { ok: false, message: 'paperLocation 只能是 school / home / varies。' };
  }
  const student = ensureStudentProfile();
  getDb().prepare(
    `INSERT INTO v2_setting (student_id, practice_slot, paper_location, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(student_id) DO UPDATE SET practice_slot = excluded.practice_slot,
       paper_location = excluded.paper_location, updated_at = excluded.updated_at`,
  ).run(student.id, practiceSlot, paperLocation, now());
  audit('v2_settings_updated', 'student', student.id);
  return { ok: true, settings: { practiceSlot, paperLocation } };
}
