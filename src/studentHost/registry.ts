/**
 * 学生邀请码注册表（2026-10-15 手机网页版 + 每学生邀请码）。
 * - 独立 SQLite（SEL_STUDENT_HOST_DIR/registry.db），与业务库完全分开；目录 0700、库文件 0600。
 * - 只存邀请码与会话令牌的 SHA256，不落明文；邀请码 12 位（32 字母表，60 bit 安全随机），
 *   大小写不敏感、允许空格/短横线分组，一次性、7 天过期；会话令牌 256 bit、30 天。
 * - 受控试用上限 MAX_STUDENTS 个学生空间；达到上限拒绝新建，绝不复用别人的空间。
 * - 兑换在 BEGIN IMMEDIATE 事务里「查 + 标记已用 + 建会话」，并发兑换只有一个成功。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const MAX_STUDENTS = 3;
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Crockford base32（不含 I/L/O/U，读错成 1/0 也无歧义）；32 个字符 × 12 位 = 60 bit。 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 12;
const BUSY_TIMEOUT_MS = 5000;

export type RegistryErrorCode = 'capacity_full' | 'invalid_code' | 'student_not_found';

export class RegistryError extends Error {
  constructor(public readonly code: RegistryErrorCode, message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

export interface StudentRecord {
  studentId: string;
  createdAt: string;
  /** 未过期且未兑换的邀请码数量（不暴露码本身）。 */
  pendingInvitations: number;
  /** 未过期且未撤销的会话数量。 */
  activeSessions: number;
}

export interface RedeemedSession {
  studentId: string;
  /** 会话令牌明文：只在兑换成功这一刻返回给网关写 cookie，注册表只存 SHA256。 */
  sessionToken: string;
  expiresAt: Date;
}

/** 邀请码规范化：去空格/短横线、转大写；不合法返回 null（不区分「不存在」与「格式错」）。 */
export function normalizeInviteCode(input: string): string | null {
  const cleaned = input.toUpperCase().replace(/[\s-]+/g, '');
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const ch of cleaned) if (!CODE_ALPHABET.includes(ch)) return null;
  return cleaned;
}

/** 展示形态：XXXX-XXXX-XXXX。 */
export function formatInviteCode(normalized: string): string {
  return [normalized.slice(0, 4), normalized.slice(4, 8), normalized.slice(8, 12)].join('-');
}

function generateCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[bytes[i]! & 31];
  return code;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** 管理员存储位置：SEL_STUDENT_HOST_DIR，缺省 <旧 dataDir>/student-host。 */
export function resolveStudentHostDir(mobileDataDir?: string): string {
  const explicit = process.env.SEL_STUDENT_HOST_DIR;
  if (explicit && explicit.trim()) return path.resolve(explicit);
  const base = mobileDataDir ?? path.resolve(process.env.SEL_MOBILE_DATA_DIR ?? 'data/mobile-recognition');
  return path.join(base, 'student-host');
}

export interface StudentRegistryOptions { now?: () => Date }

export class StudentRegistry {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  private constructor(readonly hostDir: string, options?: StudentRegistryOptions) {
    this.now = options?.now ?? ((): Date => new Date());
    fs.mkdirSync(this.studentsRoot(), { recursive: true, mode: 0o700 });
    fs.chmodSync(this.hostDir, 0o700);
    fs.chmodSync(this.studentsRoot(), 0o700);
    this.db = new DatabaseSync(path.join(this.hostDir, 'registry.db'));
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS students (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invitations (
        code_hash TEXT PRIMARY KEY,
        student_id TEXT NOT NULL REFERENCES students(id),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        redeemed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        student_id TEXT NOT NULL REFERENCES students(id),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_invitations_student ON invitations(student_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_student ON sessions(student_id);
    `);
    fs.chmodSync(path.join(this.hostDir, 'registry.db'), 0o600);
  }

  static open(hostDir: string, options?: StudentRegistryOptions): StudentRegistry {
    const resolved = path.resolve(hostDir);
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    return new StudentRegistry(resolved, options);
  }

  /** 各学生空间的根目录（hostDir/students/<server 生成的 uuid>，0700）。 */
  studentsRoot(): string {
    return path.join(this.hostDir, 'students');
  }

  studentDir(studentId: string): string {
    return path.join(this.studentsRoot(), studentId);
  }

  private studentExists(studentId: string): boolean {
    return this.db.prepare('SELECT 1 FROM students WHERE id = ?').get(studentId) !== undefined;
  }

  /** 新建学生空间（含独立数据目录，0700）；达到 MAX_STUDENTS 拒绝。 */
  createStudent(): { studentId: string; studentDir: string } {
    const studentId = crypto.randomUUID();
    const studentDir = this.studentDir(studentId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const count = (this.db.prepare('SELECT COUNT(*) AS n FROM students').get() as { n: number }).n;
      if (count >= MAX_STUDENTS) throw new RegistryError('capacity_full', `学生空间已满（最多 ${MAX_STUDENTS} 个），不能再新建。`);
      // 先落目录再登记；登记失败把空目录清掉，不留下无主空间。
      fs.mkdirSync(studentDir, { recursive: false, mode: 0o700 });
      fs.chmodSync(studentDir, 0o700);
      this.db.prepare('INSERT INTO students (id, created_at) VALUES (?, ?)').run(studentId, this.now().toISOString());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      fs.rmSync(studentDir, { recursive: true, force: true });
      throw error;
    }
    return { studentId, studentDir };
  }

  /** 生成一次性邀请码；明文只在这里返回一次（CLI 打印给管理员），库中只存 SHA256。 */
  issueInvitation(studentId: string): { code: string; expiresAt: Date } {
    if (!this.studentExists(studentId)) throw new RegistryError('student_not_found', '学生不存在。');
    const normalized = generateCode();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + INVITATION_TTL_MS);
    this.db.prepare('INSERT INTO invitations (code_hash, student_id, created_at, expires_at, redeemed_at) VALUES (?, ?, ?, ?, NULL)')
      .run(sha256(normalized), studentId, createdAt.toISOString(), expiresAt.toISOString());
    return { code: formatInviteCode(normalized), expiresAt };
  }

  /**
   * 兑换邀请码 → 新会话。错误一律 invalid_code（不暴露学生存在性：不存在/已用/过期同样说法）。
   * 事务内「标记已用（仅当未用）→ 建会话」，并发只有一方生效。
   */
  redeem(input: string): RedeemedSession {
    const normalized = normalizeInviteCode(input);
    if (normalized === null) throw new RegistryError('invalid_code', '邀请码不正确或已经失效。');
    const codeHash = sha256(normalized);
    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      type InvitationRow = { student_id: string; expires_at: string; redeemed_at: string | null };
      const invitation = this.db.prepare('SELECT student_id, expires_at, redeemed_at FROM invitations WHERE code_hash = ?').get(codeHash) as InvitationRow | undefined;
      if (!invitation || invitation.redeemed_at !== null || now.getTime() >= Date.parse(invitation.expires_at)) {
        throw new RegistryError('invalid_code', '邀请码不正确或已经失效。');
      }
      const claimed = this.db.prepare('UPDATE invitations SET redeemed_at = ? WHERE code_hash = ? AND redeemed_at IS NULL')
        .run(now.toISOString(), codeHash);
      if (Number(claimed.changes) !== 1) throw new RegistryError('invalid_code', '邀请码不正确或已经失效。');
      const token = crypto.randomBytes(32).toString('base64url');
      const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
      this.db.prepare('INSERT INTO sessions (token_hash, student_id, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)')
        .run(sha256(token), invitation.student_id, now.toISOString(), expiresAt.toISOString());
      this.db.exec('COMMIT');
      return { studentId: invitation.student_id, sessionToken: token, expiresAt };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 会话令牌 → 学生；过期/撤销/不存在一律 null（网关按未登录处理）。 */
  authenticate(sessionToken: string): { studentId: string } | null {
    if (typeof sessionToken !== 'string' || sessionToken.length === 0 || sessionToken.length > 512) return null;
    type SessionRow = { student_id: string; expires_at: string; revoked: number };
    const row = this.db.prepare('SELECT student_id, expires_at, revoked FROM sessions WHERE token_hash = ?').get(sha256(sessionToken)) as SessionRow | undefined;
    if (!row || row.revoked !== 0) return null;
    if (this.now().getTime() >= Date.parse(row.expires_at)) return null;
    return { studentId: row.student_id };
  }

  /** 退出登录：立即使该会话失效。令牌不存在也静默成功（幂等）。 */
  revokeSession(sessionToken: string): void {
    if (typeof sessionToken !== 'string' || sessionToken.length === 0 || sessionToken.length > 512) return;
    this.db.prepare('UPDATE sessions SET revoked = 1 WHERE token_hash = ?').run(sha256(sessionToken));
  }

  /** 换手机/补码之外的管理手段：撤销某学生的全部会话（返回撤销条数）。 */
  revokeSessions(studentId: string): number {
    if (!this.studentExists(studentId)) throw new RegistryError('student_not_found', '学生不存在。');
    const result = this.db.prepare('UPDATE sessions SET revoked = 1 WHERE student_id = ? AND revoked = 0').run(studentId);
    return Number(result.changes);
  }

  listStudents(): StudentRecord[] {
    const nowIso = this.now().toISOString();
    const students = this.db.prepare('SELECT id, created_at FROM students ORDER BY created_at').all() as Array<{ id: string; created_at: string }>;
    return students.map(student => ({
      studentId: student.id,
      createdAt: student.created_at,
      pendingInvitations: (this.db.prepare('SELECT COUNT(*) AS n FROM invitations WHERE student_id = ? AND redeemed_at IS NULL AND expires_at > ?').get(student.id, nowIso) as { n: number }).n,
      activeSessions: (this.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE student_id = ? AND revoked = 0 AND expires_at > ?').get(student.id, nowIso) as { n: number }).n,
    }));
  }

  close(): void {
    this.db.close();
  }
}
