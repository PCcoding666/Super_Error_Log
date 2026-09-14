import { getDb, newId, now } from '../db/connection.js';
import { audit } from './eventLog.js';
import type { Role, Subject } from '../domain/types.js';

export interface StudentProfile {
  id: string;
  nickname: string;
  grade: string;
  subjects: Subject[];
  weekend_pref: string;
  created_at: string;
}

interface ProfileRow {
  id: string;
  nickname: string;
  grade: string;
  subjects: string;
  weekend_pref: string;
  created_at: string;
}

export function getProfile(): StudentProfile | null {
  const row = getDb().prepare('SELECT * FROM student_profile ORDER BY created_at LIMIT 1').get() as
    | ProfileRow
    | undefined;
  if (!row) return null;
  return { ...row, subjects: JSON.parse(row.subjects) as Subject[] };
}

export function createProfile(input: {
  nickname: string;
  subjects: Subject[];
  weekendPref: string;
}): StudentProfile {
  const existing = getProfile();
  if (existing) return existing;
  const id = newId('stu');
  getDb()
    .prepare(
      'INSERT INTO student_profile (id, nickname, grade, subjects, weekend_pref, created_at) VALUES (?,?,?,?,?,?)',
    )
    .run(id, input.nickname, '初三', JSON.stringify(input.subjects), input.weekendPref, now());
  getDb()
    .prepare('INSERT INTO guardian_view_policy (student_id) VALUES (?)')
    .run(id);
  audit('onboarding_completed', 'student', id);
  return getProfile()!;
}

export function requireProfile(): StudentProfile {
  const p = getProfile();
  if (!p) throw new Error('尚未创建学生档案');
  return p;
}

export function roleFromCookie(header: string | undefined): Role {
  if (!header) return 'student';
  const m = /(?:^|;\s*)sel_role=(\w+)/.exec(header);
  return m?.[1] === 'parent' ? 'parent' : 'student';
}
