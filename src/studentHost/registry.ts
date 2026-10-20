/**
 * 学生邀请码注册表（2026-10-15 手机网页版 + 每学生邀请码）。
 * - 独立 SQLite（SEL_STUDENT_HOST_DIR/registry.db），与业务库完全分开；目录 0700、库文件 0600。
 * - 只存邀请码与会话令牌的 SHA256，不落明文；邀请码 12 位（32 字母表，60 bit 安全随机），
 *   大小写不敏感、允许空格/短横线分组，新码可重复登录、60 天过期（旧码保留单次语义）；会话令牌 256 bit、30 天。
 * - 可配置上限 SEL_MAX_STUDENTS（默认 100）个学生空间；达到上限拒绝新建，绝不复用别人的空间。
 * - 注册与登录都使用 BEGIN IMMEDIATE；姓名手机号重复不能创建第二个空间或取回已有凭证。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ACCOUNT_ROLES, isAccountRole, type AccountRole } from './accountRole.js';

export const MAX_STUDENTS = 100;
export const INVITATION_TTL_MS = 60 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Crockford base32（不含 I/L/O/U，读错成 1/0 也无歧义）；32 个字符 × 12 位 = 60 bit。 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 12;
const BUSY_TIMEOUT_MS = 5000;

export type RegistryErrorCode = 'capacity_full' | 'invalid_code' | 'student_not_found' | 'invalid_role' | 'invalid_registration';

export class RegistryError extends Error {
  constructor(public readonly code: RegistryErrorCode, message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

export interface StudentRecord {
  studentId: string;
  createdAt: string;
  /** 账号身份标签（元数据，不参与鉴权）；老库迁移后一律是 student。 */
  accountRole: AccountRole;
  lastActiveAt: string | null;
  /** 未过期且仍可使用的邀请码数量（不暴露码本身）。 */
  pendingInvitations: number;
  /** 未过期且未撤销的会话数量。 */
  activeSessions: number;
}

export interface InvitationRecord {
  invitationId: string;
  studentId: string;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  status: 'pending' | 'active' | 'redeemed' | 'expired';
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

export interface StudentRegistryOptions { now?: () => Date; maxStudents?: number }

interface RegistrationIdentity { name: string; phone: string }

/** 手机号只用于资料匹配，不代表已验证号码归属，更不能作为登录凭证。 */
function registrationIdentity(name: string, phone: string): RegistrationIdentity {
  if (typeof name !== 'string' || typeof phone !== 'string' || name.length > 200 || phone.length > 80) {
    throw new RegistryError('invalid_registration', '请填写姓名和有效手机号。');
  }
  const normalizedName = name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  let normalizedPhone = phone.normalize('NFKC').trim().replace(/[\s()-]/gu, '');
  if (!normalizedName || normalizedName.length > 60 || /[\p{Cc}\p{Cf}]/u.test(normalizedName)
    || !/^\+?[0-9]{7,15}$/.test(normalizedPhone)) {
    throw new RegistryError('invalid_registration', '请填写姓名和有效手机号。');
  }
  // 同一个大陆手机号的本地写法与 +86 写法归一；其他号码保留显式区号。
  if (/^1[3-9][0-9]{9}$/.test(normalizedPhone)) normalizedPhone = '+86' + normalizedPhone;
  return { name: normalizedName, phone: normalizedPhone };
}

export class StudentRegistry {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  readonly maxStudents: number;

  private constructor(readonly hostDir: string, options?: StudentRegistryOptions) {
    this.now = options?.now ?? ((): Date => new Date());
    this.maxStudents = Number(options?.maxStudents ?? process.env.SEL_MAX_STUDENTS ?? MAX_STUDENTS);
    if (!Number.isSafeInteger(this.maxStudents) || this.maxStudents < 1) {
      throw new Error('SEL_MAX_STUDENTS 必须是大于 0 的整数。');
    }
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
    this.migrateAccountRole();
    // Add public identifiers without retaining or revealing invitation secrets.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const columns = this.db.prepare('PRAGMA table_info(invitations)').all() as Array<{ name: string }>;
      if (!columns.some(column => column.name === 'public_id')) this.db.exec('ALTER TABLE invitations ADD COLUMN public_id TEXT');
      const students = this.db.prepare('PRAGMA table_info(students)').all() as Array<{ name: string }>;
      if (!students.some(column => column.name === 'last_seen_at')) this.db.exec('ALTER TABLE students ADD COLUMN last_seen_at TEXT');
      const missing = this.db.prepare('SELECT code_hash FROM invitations WHERE public_id IS NULL').all() as Array<{ code_hash: string }>;
      for (const row of missing) this.db.prepare('UPDATE invitations SET public_id = ? WHERE code_hash = ?').run(crypto.randomUUID(), row.code_hash);
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_invitation_public_id ON invitations(public_id); COMMIT;');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.migrateRegistration();
    fs.chmodSync(path.join(this.hostDir, 'registry.db'), 0o600);
  }

  /**
   * 账号身份标签的增量迁移（2026-10-15）：老库补 account_role 列，已有账号一律 student。
   * BEGIN IMMEDIATE 序列化「检测列 + 加列」，多进程同时开库只有一个执行 ALTER；新库建表后同样走这里。
   * 只做 ADD COLUMN，没有任何破坏性 SQL。
   */
  private migrateAccountRole(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const columns = this.db.prepare('PRAGMA table_info(students)').all() as Array<{ name: string }>;
      if (!columns.some(column => column.name === 'account_role')) {
        this.db.exec(`ALTER TABLE students ADD COLUMN account_role TEXT NOT NULL DEFAULT 'student' CHECK (account_role IN ('student', 'parent', 'teacher', 'admin'))`);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 增量迁移：已有账号不需要姓名手机号；已用/已过期旧码不恢复。 */
  private migrateRegistration(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS student_registration (
          student_id TEXT PRIMARY KEY REFERENCES students(id),
          name TEXT NOT NULL,
          phone TEXT NOT NULL,
          UNIQUE(name, phone)
        );
      `);
      const columns = this.db.prepare('PRAGMA table_info(invitations)').all() as Array<{ name: string }>;
      if (!columns.some(column => column.name === 'reusable')) {
        this.db.exec('ALTER TABLE invitations ADD COLUMN reusable INTEGER NOT NULL DEFAULT 0 CHECK (reusable IN (0, 1))');
        const pending = this.db.prepare('SELECT code_hash, created_at, expires_at FROM invitations WHERE redeemed_at IS NULL AND expires_at > ?')
          .all(this.now().toISOString()) as Array<{ code_hash: string; created_at: string; expires_at: string }>;
        for (const row of pending) {
          const extended = new Date(Date.parse(row.created_at) + INVITATION_TTL_MS);
          if (extended.getTime() > Date.parse(row.expires_at)) {
            this.db.prepare('UPDATE invitations SET expires_at = ? WHERE code_hash = ?').run(extended.toISOString(), row.code_hash);
          }
        }
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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

  /** 新建学生空间（含独立数据目录，0700）；达到配置上限拒绝。身份只是标签，先校验再碰目录/库。 */
  createStudent(role: AccountRole = 'student'): { studentId: string; studentDir: string } {
    if (!isAccountRole(role)) throw new RegistryError('invalid_role', `身份只能是 ${ACCOUNT_ROLES.join(' / ')}。`);
    const studentId = crypto.randomUUID();
    const studentDir = this.studentDir(studentId);
    let madeDirectory = false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.checkCapacity();
      // 先落目录再登记；登记失败把空目录清掉，不留下无主空间。
      fs.mkdirSync(studentDir, { recursive: false, mode: 0o700 });
      madeDirectory = true;
      fs.chmodSync(studentDir, 0o700);
      this.db.prepare('INSERT INTO students (id, created_at, account_role) VALUES (?, ?, ?)').run(studentId, this.now().toISOString(), role);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (madeDirectory) fs.rmSync(studentDir, { recursive: true, force: true });
      throw error;
    }
    return { studentId, studentDir };
  }

  private checkCapacity(): void {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM students').get() as { n: number }).n;
    if (count >= this.maxStudents) throw new RegistryError('capacity_full', '注册名额暂时已满，请联系管理员。');
  }

  /** 注册、身份资料、邀请码与目录是同一个工作单元；失败不留下占用名额的空账号。 */
  registerStudent(name: string, phone: string): { studentId: string; code: string; expiresAt: Date } {
    const identity = registrationIdentity(name, phone);
    const studentId = crypto.randomUUID();
    const studentDir = this.studentDir(studentId);
    let madeDirectory = false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT 1 FROM student_registration WHERE name = ? AND phone = ?').get(identity.name, identity.phone)) {
        throw new RegistryError('invalid_registration', '无法完成注册；如果以前注册过，请用邀请码登录或联系管理员找回。');
      }
      this.checkCapacity();
      fs.mkdirSync(studentDir, { recursive: false, mode: 0o700 });
      madeDirectory = true;
      fs.chmodSync(studentDir, 0o700);
      this.db.prepare("INSERT INTO students (id, created_at, account_role) VALUES (?, ?, 'student')").run(studentId, this.now().toISOString());
      this.db.prepare('INSERT INTO student_registration (student_id, name, phone) VALUES (?, ?, ?)').run(studentId, identity.name, identity.phone);
      const invitation = this.issueInvitation(studentId);
      this.db.exec('COMMIT');
      return { studentId, ...invitation };
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (madeDirectory) fs.rmSync(studentDir, { recursive: true, force: true });
      throw error;
    }
  }

  /** 仅供管理员本机核验后定位账号；没有公开 HTTP 查询/取码接口。 */
  findRegisteredStudent(name: string, phone: string): string | null {
    const identity = registrationIdentity(name, phone);
    const row = this.db.prepare('SELECT student_id FROM student_registration WHERE name = ? AND phone = ?')
      .get(identity.name, identity.phone) as { student_id: string } | undefined;
    return row?.student_id ?? null;
  }

  /** 读账号身份标签（每请求调用，setAccountRole 后下一个请求即生效，不用重新登录）。 */
  getAccountRole(studentId: string): AccountRole {
    const row = this.db.prepare('SELECT account_role FROM students WHERE id = ?').get(studentId) as { account_role: string } | undefined;
    if (!row) throw new RegistryError('student_not_found', '学生不存在。');
    // CHECK 约束保证四值之一；这里再验一次，宁可报数据损坏也不放行未知身份。
    if (!isAccountRole(row.account_role)) throw new RegistryError('invalid_role', '账号身份数据损坏，请用管理 CLI 重新设置。');
    return row.account_role;
  }

  /** 改账号身份标签（只是元数据，不动目录/会话/学习记录）。 */
  setAccountRole(studentId: string, role: AccountRole): void {
    if (!isAccountRole(role)) throw new RegistryError('invalid_role', `身份只能是 ${ACCOUNT_ROLES.join(' / ')}。`);
    const result = this.db.prepare('UPDATE students SET account_role = ? WHERE id = ?').run(role, studentId);
    if (Number(result.changes) !== 1) throw new RegistryError('student_not_found', '学生不存在。');
  }

  /** 生成绑定本学生的可复用邀请码；明文仅在创建时返回，库中只存 SHA256。 */
  issueInvitation(studentId: string): { code: string; expiresAt: Date } {
    if (!this.studentExists(studentId)) throw new RegistryError('student_not_found', '学生不存在。');
    const normalized = generateCode();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + INVITATION_TTL_MS);
    this.db.prepare('INSERT INTO invitations (code_hash, student_id, created_at, expires_at, redeemed_at, public_id, reusable) VALUES (?, ?, ?, ?, NULL, ?, 1)')
      .run(sha256(normalized), studentId, createdAt.toISOString(), expiresAt.toISOString(), crypto.randomUUID());
    return { code: formatInviteCode(normalized), expiresAt };
  }

  /**
   * 兑换邀请码 → 新会话。错误一律 invalid_code（不暴露学生存在性：不存在/已用/过期同样说法）。
   * 新码可在有效期内多次登录；旧的一次性码仍只允许一方兑换，不复活历史凭证。
   */
  redeem(input: string): RedeemedSession {
    const normalized = normalizeInviteCode(input);
    if (normalized === null) throw new RegistryError('invalid_code', '邀请码不正确或已经失效。');
    const codeHash = sha256(normalized);
    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      type InvitationRow = { student_id: string; expires_at: string; redeemed_at: string | null; reusable: number };
      const invitation = this.db.prepare('SELECT student_id, expires_at, redeemed_at, reusable FROM invitations WHERE code_hash = ?').get(codeHash) as InvitationRow | undefined;
      if (!invitation || (invitation.reusable === 0 && invitation.redeemed_at !== null) || now.getTime() >= Date.parse(invitation.expires_at)) {
        throw new RegistryError('invalid_code', '邀请码不正确或已经失效。');
      }
      const claimed = this.db.prepare('UPDATE invitations SET redeemed_at = COALESCE(redeemed_at, ?) WHERE code_hash = ? AND (reusable = 1 OR redeemed_at IS NULL)')
        .run(now.toISOString(), codeHash);
      if (Number(claimed.changes) !== 1) throw new RegistryError('invalid_code', '邀请码不正确或已经失效。');
      const token = crypto.randomBytes(32).toString('base64url');
      const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
      this.db.prepare('INSERT INTO sessions (token_hash, student_id, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)')
        .run(sha256(token), invitation.student_id, now.toISOString(), expiresAt.toISOString());
      this.db.prepare('UPDATE students SET last_seen_at = ? WHERE id = ?').run(now.toISOString(), invitation.student_id);
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
    const students = this.db.prepare('SELECT id, created_at, account_role, last_seen_at FROM students ORDER BY created_at').all() as Array<{ id: string; created_at: string; account_role: string; last_seen_at: string | null }>;
    return students.map(student => ({
      studentId: student.id,
      createdAt: student.created_at,
      accountRole: isAccountRole(student.account_role) ? student.account_role : 'student',
      lastActiveAt: student.last_seen_at,
      pendingInvitations: (this.db.prepare('SELECT COUNT(*) AS n FROM invitations WHERE student_id = ? AND (reusable = 1 OR redeemed_at IS NULL) AND expires_at > ?').get(student.id, nowIso) as { n: number }).n,
      activeSessions: (this.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE student_id = ? AND revoked = 0 AND expires_at > ?').get(student.id, nowIso) as { n: number }).n,
    }));
  }

  recordActivity(studentId: string): void {
    // This observer must neither delay nor fail an authenticated student request.
    // All operations here are synchronous, so the normal timeout is restored before any other caller runs.
    try {
      try {
        this.db.exec('PRAGMA busy_timeout = 0');
        const now = this.now();
        const cutoff = new Date(now.getTime() - 60_000).toISOString();
        const row = this.db.prepare('SELECT last_seen_at FROM students WHERE id = ?').get(studentId) as { last_seen_at: string | null } | undefined;
        if (!row || (row.last_seen_at !== null && row.last_seen_at >= cutoff)) return;
        this.db.prepare('UPDATE students SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)')
          .run(now.toISOString(), studentId, cutoff);
      } finally { this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`); }
    } catch { /* Best-effort metadata: a later request can update it after contention/storage recovery. */ }
  }

  listInvitations(): InvitationRecord[] {
    const rows = this.db.prepare(`SELECT public_id AS invitationId, student_id AS studentId, created_at AS createdAt,
      expires_at AS expiresAt, redeemed_at AS redeemedAt, reusable FROM invitations ORDER BY created_at DESC, public_id`).all() as unknown as Array<Omit<InvitationRecord, 'status'> & { reusable: number }>;
    const now = this.now().getTime();
    return rows.map(({ reusable, ...row }) => ({
      ...row,
      status: reusable === 0 && row.redeemedAt ? 'redeemed'
        : Date.parse(row.expiresAt) <= now ? 'expired' : row.redeemedAt ? 'active' : 'pending',
    }));
  }

  close(): void {
    this.db.close();
  }
}
