/**
 * 学生邀请码注册表（2026-10-15 手机网页版 + 每学生邀请码）。
 * - 独立 SQLite（SEL_STUDENT_HOST_DIR/registry.db），与业务库完全分开；目录 0700、库文件 0600。
 * - 只存邀请码与会话令牌的 SHA256，不落明文；邀请码 12 位（32 字母表，60 bit 安全随机），
 *   大小写不敏感、允许空格/短横线分组，新码可重复登录、60 天过期（旧码保留单次语义）；会话令牌 256 bit、30 天。
 * - 可配置上限 SEL_MAX_STUDENTS（默认 100）个学生空间；达到上限拒绝新建，绝不复用别人的空间。
 * - 注册与登录都使用 BEGIN IMMEDIATE；姓名手机号重复不能创建第二个空间或取回已有凭证。
 * - 2026-10-22（P0-6/P0-10/P0-11/P1-5/P1-6，只做增量迁移）：
 *   - 公开注册必须带「注册码」（老师/管理员用 CLI 预发的班级码，可限次数与天数）；管理员 CLI 建号不受影响。
 *   - 注册时记录同意的隐私规则版本、年龄段与（未满 14 周岁时的）监护人同意。
 *   - 会话滑动续期：活跃使用时把 30 天往后顺延（每天最多写一次）。
 *   - 登录会话可以在本设备上找回自己的邀请码：邀请码明文只以「用该会话令牌派生的密钥」加密存放，
 *     库里没有令牌明文，单独拿到 registry.db 解不开；学生也能一键重新生成（旧码与其他设备会话作废）。
 *   - 停用（disable）、删除（delete）、导出（export）供管理员 CLI 使用。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ACCOUNT_ROLES, isAccountRole, type AccountRole } from './accountRole.js';
import { liveWorkerPid, WORKER_PID_FILE } from './workerLock.js';

export const MAX_STUDENTS = 100;
export const INVITATION_TTL_MS = 60 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Crockford base32（不含 I/L/O/U，读错成 1/0 也无歧义）；32 个字符 × 12 位 = 60 bit。 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 12;
const BUSY_TIMEOUT_MS = 5000;

export type RegistryErrorCode = 'capacity_full' | 'invalid_code' | 'student_not_found' | 'invalid_role' | 'invalid_registration'
  | 'invalid_registration_code' | 'duplicate_registration' | 'student_active'
  | 'invalid_recovery_pin' | 'recovery_failed' | 'recovery_locked' | 'not_self_registered';

/** 会话离到期不足（30 天 − 1 天）时顺延：活跃学生最多每天写一次注册表。 */
export const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;
/** 邀请码到期前多少天开始在设置页提醒。 */
export const INVITATION_WARN_MS = 7 * 24 * 60 * 60 * 1000;
/** 注册码（班级码）：8 位，同一字母表（40 bit）；登录页的 12 位邀请码不会被误认成注册码。 */
const REGISTRATION_CODE_LENGTH = 8;
export const REGISTRATION_CODE_DEFAULT_DAYS = 14;
export const REGISTRATION_CODE_DEFAULT_USES = 60;

/** 找回码：注册时自己设的 4 位数字；忘了邀请码时和姓名、手机号一起用来自助换新码。 */
const RECOVERY_PIN_LENGTH = 4;
/** 同一账号连续输错几次找回码后锁定；锁定多久。计数存在注册表里，服务重启不清零。 */
export const RECOVERY_MAX_FAILURES = 5;
export const RECOVERY_LOCK_MS = 24 * 60 * 60 * 1000;

export interface RegistrationCodeRecord {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  usedCount: number;
  revokedAt: string | null;
  status: 'active' | 'used_up' | 'expired' | 'revoked';
}

export interface RegistrationSearchResult {
  studentId: string;
  name: string;
  phoneLast4: string;
  createdAt: string;
  disabledAt: string | null;
}

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
  /** 自助注册登记的姓名（管理员 CLI 建的号为 null）；只给管理员看。 */
  registeredName: string | null;
  /** 登记手机号最后 4 位。 */
  phoneLast4: string | null;
  /** 已停用时间（停用后不能登录）。 */
  disabledAt: string | null;
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

function generateCode(length = CODE_LENGTH): string {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i += 1) code += CODE_ALPHABET[bytes[i]! & 31];
  return code;
}

/** 注册码规范化：8 位，规则同邀请码（去空格/短横线、转大写）。 */
export function normalizeRegistrationCode(input: string): string | null {
  if (typeof input !== 'string' || input.length > 40) return null;
  const cleaned = input.toUpperCase().replace(/[\s-]+/g, '');
  if (cleaned.length !== REGISTRATION_CODE_LENGTH) return null;
  for (const ch of cleaned) if (!CODE_ALPHABET.includes(ch)) return null;
  return cleaned;
}

export function formatRegistrationCode(normalized: string): string {
  return normalized.slice(0, 4) + '-' + normalized.slice(4, 8);
}

/** 本会话找回邀请码用的密钥：只从会话令牌派生（库里只有令牌的 SHA256，单独拿到库解不开）。 */
function boxKey(sessionToken: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(sessionToken, 'utf8'), Buffer.from('sel-invite-box'), Buffer.from('v1'), 32));
}

function sealCode(sessionToken: string, normalizedCode: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', boxKey(sessionToken), iv);
  const body = Buffer.concat([cipher.update(normalizedCode, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

function openCode(sessionToken: string, box: string): string | null {
  try {
    const raw = Buffer.from(box, 'base64url');
    if (raw.length < 29) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', boxKey(sessionToken), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const code = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    return normalizeInviteCode(code);
  } catch { return null; }
}

/** 真实绝对路径：存在的部分用 realpath 解开符号链接，不存在的尾部原样拼回。 */
function canonicalPath(input: string): string {
  let current = path.resolve(input);
  const rest: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...rest);
}

function phoneLast4(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^0-9]/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** 4 位数字；太好猜的（四位相同、顺着或倒着数）不收。不合格返回 null。 */
export function normalizeRecoveryPin(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const pin = input.normalize('NFKC').replace(/\s+/g, '');
  if (!new RegExp(`^[0-9]{${RECOVERY_PIN_LENGTH}}$`).test(pin)) return null;
  const digits = [...pin].map(Number);
  const steps = new Set(digits.slice(1).map((digit, index) => digit - digits[index]!));
  if (steps.size === 1 && [0, 1, -1].includes([...steps][0]!)) return null;
  return pin;
}

/** 找回码只存加盐的 scrypt 摘要。 */
function hashRecoveryPin(pin: string): string {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64url')}$${crypto.scryptSync(pin, salt, 32).toString('base64url')}`;
}

function recoveryPinMatches(pin: string, stored: string | null): boolean {
  const [scheme, salt, hash] = (stored ?? '').split('$');
  // 没有存过找回码时也算一遍，回应时间不暴露账号是否设过找回码。
  const actual = crypto.scryptSync(pin, Buffer.from(salt ?? '', 'base64url'), 32);
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
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
    this.migrateAccountsAndPrivacy();
    this.migrateRecovery();
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

  /**
   * 增量迁移（2026-10-22）：只 ADD COLUMN / CREATE TABLE，旧账号、旧码、旧会话原样可用。
   * - students.disabled_at：停用时间（NULL = 正常）。
   * - sessions.invitation_hash / code_box：本会话用哪个码登录、以及只有本会话能解开的邀请码副本（旧会话为 NULL）。
   * - sessions.renewed_at：最近一次滑动续期时间。
   * - student_registration：同意的隐私规则版本、年龄段、监护人同意、注册码编号（旧登记为 NULL）。
   * - registration_codes：注册码（只存 SHA256）。
   */
  private migrateAccountsAndPrivacy(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const has = (table: string, column: string): boolean =>
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(row => row.name === column);
      if (!has('students', 'disabled_at')) this.db.exec('ALTER TABLE students ADD COLUMN disabled_at TEXT');
      if (!has('sessions', 'invitation_hash')) this.db.exec('ALTER TABLE sessions ADD COLUMN invitation_hash TEXT');
      if (!has('sessions', 'code_box')) this.db.exec('ALTER TABLE sessions ADD COLUMN code_box TEXT');
      if (!has('sessions', 'renewed_at')) this.db.exec('ALTER TABLE sessions ADD COLUMN renewed_at TEXT');
      for (const column of ['consent_version', 'consent_at', 'age_band', 'guardian_consent', 'registration_code_id']) {
        if (!has('student_registration', column)) this.db.exec(`ALTER TABLE student_registration ADD COLUMN ${column} TEXT`);
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS registration_codes (
          code_hash TEXT PRIMARY KEY,
          public_id TEXT NOT NULL UNIQUE,
          label TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          max_uses INTEGER NOT NULL CHECK (max_uses > 0),
          used_count INTEGER NOT NULL DEFAULT 0,
          revoked_at TEXT
        );
      `);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  /**
   * 增量迁移（2026-10-23）：自助找回。只 ADD COLUMN，旧登记没有找回码（NULL），登录后可以补设。
   * - recovery_hash：找回码的加盐摘要；recovery_failures / recovery_locked_until：连续输错次数与锁定到期时间。
   */
  private migrateRecovery(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const has = (column: string): boolean =>
        (this.db.prepare('PRAGMA table_info(student_registration)').all() as Array<{ name: string }>).some(row => row.name === column);
      if (!has('recovery_hash')) this.db.exec('ALTER TABLE student_registration ADD COLUMN recovery_hash TEXT');
      if (!has('recovery_failures')) this.db.exec('ALTER TABLE student_registration ADD COLUMN recovery_failures INTEGER NOT NULL DEFAULT 0');
      if (!has('recovery_locked_until')) this.db.exec('ALTER TABLE student_registration ADD COLUMN recovery_locked_until TEXT');
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

  /**
   * 注册、身份资料、邀请码与目录是同一个工作单元；失败不留下占用名额的空账号。
   * 公开注册（网关）必须给 options.recoveryPin（4 位找回码）；网关打开了班级注册码时再带 options.registrationCode，
   * 只在注册成功时才消耗注册码的一次名额。不带 options 的调用只供本机管理/测试，不经过任何公开入口。
   */
  registerStudent(name: string, phone: string, options?: { recoveryPin?: string; registrationCode?: string }): { studentId: string; code: string; expiresAt: Date } {
    // 注册码先认（码不对时不评估姓名手机号，也计入限速）；管理入口直接校验资料。
    if (options?.registrationCode !== undefined && !this.registrationCodeUsable(options.registrationCode)) {
      throw new RegistryError('invalid_registration_code', '注册码不正确或已经失效。请向老师要班级注册码。');
    }
    const identity = registrationIdentity(name, phone);
    const pin = options ? normalizeRecoveryPin(options.recoveryPin) : null;
    if (options && pin === null) {
      throw new RegistryError('invalid_recovery_pin', '请设一个 4 位数字的找回码（不要用 1234、0000 这种），忘了邀请码时要用它。');
    }
    const studentId = crypto.randomUUID();
    const studentDir = this.studentDir(studentId);
    let madeDirectory = false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let registrationCodeId: string | null = null;
      if (options?.registrationCode !== undefined) {
        const normalized = normalizeRegistrationCode(options.registrationCode);
        type CodeRow = { public_id: string; expires_at: string; max_uses: number; used_count: number; revoked_at: string | null };
        const row = normalized === null ? undefined
          : this.db.prepare('SELECT public_id, expires_at, max_uses, used_count, revoked_at FROM registration_codes WHERE code_hash = ?').get(sha256(normalized)) as CodeRow | undefined;
        if (!row || row.revoked_at !== null || row.used_count >= row.max_uses || this.now().getTime() >= Date.parse(row.expires_at)) {
          throw new RegistryError('invalid_registration_code', '注册码不正确或已经失效。请向老师要班级注册码。');
        }
        registrationCodeId = row.public_id;
      }
      // 「测试 甲」和「测试甲」是同一个人：判重时忽略姓名里的空格（A19）。
      if (this.registrationRow(identity)) {
        throw new RegistryError('duplicate_registration', '这个姓名和手机号已经注册过了。忘了邀请码，可以用注册时设的找回码找回。');
      }
      this.checkCapacity();
      fs.mkdirSync(studentDir, { recursive: false, mode: 0o700 });
      madeDirectory = true;
      fs.chmodSync(studentDir, 0o700);
      const nowIso = this.now().toISOString();
      this.db.prepare("INSERT INTO students (id, created_at, account_role) VALUES (?, ?, 'student')").run(studentId, nowIso);
      this.db.prepare('INSERT INTO student_registration (student_id, name, phone, registration_code_id, recovery_hash) VALUES (?, ?, ?, ?, ?)')
        .run(studentId, identity.name, identity.phone, registrationCodeId, pin === null ? null : hashRecoveryPin(pin));
      if (registrationCodeId !== null) {
        this.db.prepare('UPDATE registration_codes SET used_count = used_count + 1 WHERE public_id = ?').run(registrationCodeId);
      }
      const invitation = this.issueInvitation(studentId);
      this.db.exec('COMMIT');
      return { studentId, ...invitation };
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (madeDirectory) fs.rmSync(studentDir, { recursive: true, force: true });
      throw error;
    }
  }

  private registrationRow(identity: RegistrationIdentity): { student_id: string; recovery_hash: string | null; recovery_failures: number; recovery_locked_until: string | null } | undefined {
    return this.db.prepare("SELECT student_id, recovery_hash, recovery_failures, recovery_locked_until FROM student_registration WHERE replace(name, ' ', '') = ? AND phone = ?")
      .get(identity.name.replace(/ /g, ''), identity.phone) as { student_id: string; recovery_hash: string | null; recovery_failures: number; recovery_locked_until: string | null } | undefined;
  }

  /**
   * 自助找回：姓名 + 手机号 + 注册时设的找回码都对，就作废旧码和全部会话，当场发一个新码。
   * 对不上一律同一句话（不说是哪一项错、账号在不在）；同一账号连续错 RECOVERY_MAX_FAILURES 次锁 24 小时，计数落库。
   * 停用的账号不能自助找回（停用要由管理员恢复）。
   */
  recoverInvitation(name: string, phone: string, pinInput: string): { code: string; expiresAt: Date } {
    const identity = registrationIdentity(name, phone);
    const pin = typeof pinInput === 'string' ? pinInput.normalize('NFKC').replace(/\s+/g, '').slice(0, 16) : '';
    const failed = new RegistryError('recovery_failed', '姓名、手机号或找回码不对。');
    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    let outcome: { code: string; expiresAt: Date } | RegistryError;
    try {
      const row = this.registrationRow(identity);
      // 先比对再看账号在不在：没有这个账号时也算一遍，回应时间不暴露谁注册过。
      const matches = recoveryPinMatches(pin, row?.recovery_hash ?? null);
      if (row?.recovery_locked_until && Date.parse(row.recovery_locked_until) > now.getTime()) {
        const until = new Date(row.recovery_locked_until).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        outcome = new RegistryError('recovery_locked', `找回码输错的次数太多了，${until}（北京时间）以后再试；也可以请老师或管理员帮你找回。`);
      } else if (!row || !matches || this.isDisabled(row.student_id)) {
        if (row) {
          const failures = row.recovery_failures + 1;
          if (failures >= RECOVERY_MAX_FAILURES) {
            this.db.prepare('UPDATE student_registration SET recovery_failures = 0, recovery_locked_until = ? WHERE student_id = ?')
              .run(new Date(now.getTime() + RECOVERY_LOCK_MS).toISOString(), row.student_id);
          } else {
            this.db.prepare('UPDATE student_registration SET recovery_failures = ? WHERE student_id = ?').run(failures, row.student_id);
          }
        }
        outcome = failed;
      } else {
        const nowIso = now.toISOString();
        this.db.prepare('UPDATE student_registration SET recovery_failures = 0, recovery_locked_until = NULL WHERE student_id = ?').run(row.student_id);
        this.db.prepare('UPDATE invitations SET expires_at = ? WHERE student_id = ? AND expires_at > ?').run(nowIso, row.student_id, nowIso);
        this.db.prepare('UPDATE sessions SET revoked = 1 WHERE student_id = ?').run(row.student_id);
        outcome = this.issueInvitation(row.student_id);
      }
      // 输错也要提交：错误次数必须记下来。
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (outcome instanceof RegistryError) throw outcome;
    return outcome;
  }

  /** 登录后设置或修改找回码（老账号补设也走这里）。只有自助注册（有姓名手机号登记）的账号才有找回。 */
  setRecoveryPin(studentId: string, pinInput: string): void {
    const pin = normalizeRecoveryPin(pinInput);
    if (pin === null) throw new RegistryError('invalid_recovery_pin', '找回码要 4 位数字，不要用 1234、0000 这种好猜的。');
    const result = this.db.prepare('UPDATE student_registration SET recovery_hash = ?, recovery_failures = 0, recovery_locked_until = NULL WHERE student_id = ?')
      .run(hashRecoveryPin(pin), studentId);
    if (Number(result.changes) !== 1) throw new RegistryError('not_self_registered', '这个账号不是用姓名和手机号注册的，找回请联系老师或管理员。');
  }

  /** 这个账号有没有设过找回码；null 表示不是自助注册的账号。 */
  hasRecoveryPin(studentId: string): boolean | null {
    const row = this.db.prepare('SELECT recovery_hash FROM student_registration WHERE student_id = ?').get(studentId) as { recovery_hash: string | null } | undefined;
    return row ? row.recovery_hash !== null : null;
  }

  // ---------- 注册码（班级码） ----------

  private registrationCodeUsable(input: string): boolean {
    const normalized = normalizeRegistrationCode(input);
    if (normalized === null) return false;
    const row = this.db.prepare('SELECT expires_at, max_uses, used_count, revoked_at FROM registration_codes WHERE code_hash = ?').get(sha256(normalized)) as
      { expires_at: string; max_uses: number; used_count: number; revoked_at: string | null } | undefined;
    return row !== undefined && row.revoked_at === null && row.used_count < row.max_uses && this.now().getTime() < Date.parse(row.expires_at);
  }

  /** 生成注册码：明文只返回这一次，库里只存 SHA256。 */
  createRegistrationCode(options: { label?: string; maxUses?: number; days?: number } = {}): { id: string; code: string; expiresAt: Date; maxUses: number; label: string } {
    const label = (options.label ?? '').normalize('NFKC').trim().slice(0, 60) || '注册码';
    const maxUses = options.maxUses ?? REGISTRATION_CODE_DEFAULT_USES;
    const days = options.days ?? REGISTRATION_CODE_DEFAULT_DAYS;
    if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1000) throw new RegistryError('invalid_registration_code', '可用次数必须是 1 到 1000 的整数。');
    if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new RegistryError('invalid_registration_code', '有效天数必须是 1 到 365 的整数。');
    const normalized = generateCode(REGISTRATION_CODE_LENGTH);
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + days * 24 * 60 * 60 * 1000);
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO registration_codes (code_hash, public_id, label, created_at, expires_at, max_uses, used_count, revoked_at) VALUES (?, ?, ?, ?, ?, ?, 0, NULL)')
      .run(sha256(normalized), id, label, createdAt.toISOString(), expiresAt.toISOString(), maxUses);
    return { id, code: formatRegistrationCode(normalized), expiresAt, maxUses, label };
  }

  listRegistrationCodes(): RegistrationCodeRecord[] {
    const now = this.now().getTime();
    const rows = this.db.prepare('SELECT public_id, label, created_at, expires_at, max_uses, used_count, revoked_at FROM registration_codes ORDER BY created_at DESC').all() as Array<{
      public_id: string; label: string; created_at: string; expires_at: string; max_uses: number; used_count: number; revoked_at: string | null;
    }>;
    return rows.map(row => ({
      id: row.public_id, label: row.label, createdAt: row.created_at, expiresAt: row.expires_at, maxUses: row.max_uses, usedCount: row.used_count, revokedAt: row.revoked_at,
      status: row.revoked_at ? 'revoked' : Date.parse(row.expires_at) <= now ? 'expired' : row.used_count >= row.max_uses ? 'used_up' : 'active',
    }));
  }

  /** 作废注册码：已经用它注册的账号不受影响。 */
  revokeRegistrationCode(id: string): void {
    const result = this.db.prepare('UPDATE registration_codes SET revoked_at = COALESCE(revoked_at, ?) WHERE public_id = ?').run(this.now().toISOString(), id);
    if (Number(result.changes) !== 1) throw new RegistryError('invalid_registration_code', '没有这个注册码编号。');
  }

  /** 仅供管理员本机核验后定位账号；没有公开 HTTP 查询/取码接口。 */
  findRegisteredStudent(name: string, phone: string): string | null {
    const identity = registrationIdentity(name, phone);
    const row = this.db.prepare('SELECT student_id FROM student_registration WHERE name = ? AND phone = ?')
      .get(identity.name, identity.phone) as { student_id: string } | undefined;
    return row?.student_id ?? null;
  }

  /**
   * 管理员按姓名片段或手机尾号查账号（P1-5）：
   * - 纯 4 位数字：按手机号最后 4 位；
   * - 其他：姓名包含该片段（忽略空白）。
   * 只给本机 CLI 用；没有 HTTP 入口。
   */
  searchRegistrations(query: string): RegistrationSearchResult[] {
    const text = (query ?? '').normalize('NFKC').replace(/\s+/gu, '');
    if (!text || text.length > 60) return [];
    const rows = this.db.prepare(`SELECT r.student_id, r.name, r.phone, s.created_at, s.disabled_at FROM student_registration r
      JOIN students s ON s.id = r.student_id ORDER BY s.created_at`).all() as Array<{ student_id: string; name: string; phone: string; created_at: string; disabled_at: string | null }>;
    const byPhone = /^[0-9]{4}$/.test(text);
    return rows
      .filter(row => byPhone ? phoneLast4(row.phone) === text : row.name.replace(/\s+/gu, '').includes(text))
      .map(row => ({ studentId: row.student_id, name: row.name, phoneLast4: phoneLast4(row.phone) ?? '', createdAt: row.created_at, disabledAt: row.disabled_at }));
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

  /** 管理员核验后的找回：原子作废旧码和会话，再发新码；失败时旧状态完整保留。 */
  resetInvitation(studentId: string): { code: string; expiresAt: Date } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.studentExists(studentId)) throw new RegistryError('student_not_found', '学生不存在。');
      const now = this.now().toISOString();
      this.db.prepare('UPDATE invitations SET expires_at = ? WHERE student_id = ? AND expires_at > ?').run(now, studentId, now);
      this.db.prepare('UPDATE sessions SET revoked = 1 WHERE student_id = ?').run(studentId);
      // 管理员核验后找回 = 重新启用（停用的账号也走这一步恢复）。
      this.db.prepare('UPDATE students SET disabled_at = NULL WHERE id = ?').run(studentId);
      const invitation = this.issueInvitation(studentId);
      this.db.exec('COMMIT');
      return invitation;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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
      if (!invitation || (invitation.reusable === 0 && invitation.redeemed_at !== null) || now.getTime() >= Date.parse(invitation.expires_at)
        || this.isDisabled(invitation.student_id)) {
        throw new RegistryError('invalid_code', '邀请码不正确或已经失效。');
      }
      const claimed = this.db.prepare('UPDATE invitations SET redeemed_at = COALESCE(redeemed_at, ?) WHERE code_hash = ? AND (reusable = 1 OR redeemed_at IS NULL)')
        .run(now.toISOString(), codeHash);
      if (Number(claimed.changes) !== 1) throw new RegistryError('invalid_code', '邀请码不正确或已经失效。');
      const token = crypto.randomBytes(32).toString('base64url');
      const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
      // 只有可重复登录的新码才留一份本会话可解的副本；旧的一次性码用过即废，不需要找回。
      const box = invitation.reusable === 1 ? sealCode(token, normalized) : null;
      this.db.prepare('INSERT INTO sessions (token_hash, student_id, created_at, expires_at, revoked, invitation_hash, code_box) VALUES (?, ?, ?, ?, 0, ?, ?)')
        .run(sha256(token), invitation.student_id, now.toISOString(), expiresAt.toISOString(), codeHash, box);
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
    if (this.isDisabled(row.student_id)) return null;
    return { studentId: row.student_id };
  }

  private isDisabled(studentId: string): boolean {
    const row = this.db.prepare('SELECT disabled_at FROM students WHERE id = ?').get(studentId) as { disabled_at: string | null } | undefined;
    return row !== undefined && row.disabled_at !== null;
  }

  /**
   * 滑动续期（P0-11）：有效会话离到期不足 (30 天 − 1 天) 时顺延到「现在 + 30 天」，返回新的到期时间；
   * 不需要续期或会话无效返回 null。网关据此重写 cookie 的 Max-Age。
   */
  renewSession(sessionToken: string): Date | null {
    if (!this.authenticate(sessionToken)) return null;
    const now = this.now();
    const hash = sha256(sessionToken);
    const row = this.db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(hash) as { expires_at: string } | undefined;
    if (!row) return null;
    if (Date.parse(row.expires_at) - now.getTime() > SESSION_TTL_MS - SESSION_RENEW_AFTER_MS) return null;
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    // 与 recordActivity 一样：续期只是顺手的元数据写入，库忙时不等待、不让本次请求失败，下一次再试。
    try {
      try {
        this.db.exec('PRAGMA busy_timeout = 0');
        this.db.prepare('UPDATE sessions SET expires_at = ?, renewed_at = ? WHERE token_hash = ? AND revoked = 0').run(expiresAt.toISOString(), now.toISOString(), hash);
      } finally { this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`); }
    } catch { return null; }
    return expiresAt;
  }

  /** 该学生当前可用的（可重复登录的）邀请码里最晚的到期时间；没有可用码返回 null。 */
  invitationExpiry(studentId: string): Date | null {
    const row = this.db.prepare('SELECT MAX(expires_at) AS t FROM invitations WHERE student_id = ? AND reusable = 1 AND expires_at > ?')
      .get(studentId, this.now().toISOString()) as { t: string | null };
    return row.t ? new Date(row.t) : null;
  }

  /**
   * 本设备查看自己的邀请码：只有用可重复登录的新码登录的会话，才能解开它登录时用的那个码；
   * 码已过期/作废、旧会话（迁移前登录）返回 code = null，页面改为提供「重新生成」。
   */
  sessionInvitation(sessionToken: string): { code: string | null; expiresAt: Date | null; studentExpiresAt: Date | null } | null {
    const session = this.authenticate(sessionToken);
    if (!session) return null;
    const row = this.db.prepare('SELECT invitation_hash, code_box FROM sessions WHERE token_hash = ?').get(sha256(sessionToken)) as { invitation_hash: string | null; code_box: string | null } | undefined;
    const studentExpiresAt = this.invitationExpiry(session.studentId);
    if (!row?.invitation_hash || !row.code_box) return { code: null, expiresAt: null, studentExpiresAt };
    const invitation = this.db.prepare('SELECT expires_at, reusable FROM invitations WHERE code_hash = ? AND student_id = ?').get(row.invitation_hash, session.studentId) as { expires_at: string; reusable: number } | undefined;
    if (!invitation || invitation.reusable !== 1 || this.now().getTime() >= Date.parse(invitation.expires_at)) return { code: null, expiresAt: null, studentExpiresAt };
    const code = openCode(sessionToken, row.code_box);
    if (!code || sha256(code) !== row.invitation_hash) return { code: null, expiresAt: null, studentExpiresAt };
    return { code: formatInviteCode(code), expiresAt: new Date(invitation.expires_at), studentExpiresAt };
  }

  /**
   * 学生在设置里一键重新生成邀请码：原子作废本人全部旧码和「其他设备」的会话，发一个新码，
   * 当前会话保留并能看到新码。失败时旧状态完整保留。
   */
  regenerateOwnInvitation(sessionToken: string): { code: string; expiresAt: Date } {
    const session = this.authenticate(sessionToken);
    if (!session) throw new RegistryError('invalid_code', '需要重新登录。');
    const hash = sha256(sessionToken);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = this.now().toISOString();
      this.db.prepare('UPDATE invitations SET expires_at = ? WHERE student_id = ? AND expires_at > ?').run(now, session.studentId, now);
      this.db.prepare('UPDATE sessions SET revoked = 1 WHERE student_id = ? AND token_hash <> ?').run(session.studentId, hash);
      const invitation = this.issueInvitation(session.studentId);
      const normalized = normalizeInviteCode(invitation.code)!;
      this.db.prepare('UPDATE sessions SET invitation_hash = ?, code_box = ? WHERE token_hash = ?').run(sha256(normalized), sealCode(sessionToken, normalized), hash);
      this.db.exec('COMMIT');
      return invitation;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  /** 退出登录：立即使该会话失效。令牌不存在也静默成功（幂等）。 */
  revokeSession(sessionToken: string): void {
    if (typeof sessionToken !== 'string' || sessionToken.length === 0 || sessionToken.length > 512) return;
    this.db.prepare('UPDATE sessions SET revoked = 1 WHERE token_hash = ?').run(sha256(sessionToken));
  }

  /**
   * 换手机/补码之外的管理手段：撤销某学生的全部会话（返回撤销条数）。
   * 注意：只踢下线，**不作废邀请码**——持码人可以马上再登录。要封禁请用 disableStudent；要换码请用 resetInvitation。
   */
  revokeSessions(studentId: string): number {
    if (!this.studentExists(studentId)) throw new RegistryError('student_not_found', '学生不存在。');
    const result = this.db.prepare('UPDATE sessions SET revoked = 1 WHERE student_id = ? AND revoked = 0').run(studentId);
    return Number(result.changes);
  }

  listStudents(): StudentRecord[] {
    const nowIso = this.now().toISOString();
    const students = this.db.prepare(`SELECT s.id, s.created_at, s.account_role, s.last_seen_at, s.disabled_at, r.name, r.phone FROM students s
      LEFT JOIN student_registration r ON r.student_id = s.id ORDER BY s.created_at`).all() as Array<{
      id: string; created_at: string; account_role: string; last_seen_at: string | null; disabled_at: string | null; name: string | null; phone: string | null;
    }>;
    return students.map(student => ({
      registeredName: student.name ?? null,
      phoneLast4: phoneLast4(student.phone),
      disabledAt: student.disabled_at ?? null,
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

  // ---------- 停用 / 删除 / 导出（只供本机管理员 CLI） ----------

  /** 停用：作废全部邀请码和会话，之后不能登录；学习数据保留。用 resetInvitation 恢复。 */
  disableStudent(studentId: string): { revokedSessions: number; expiredInvitations: number } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.studentExists(studentId)) throw new RegistryError('student_not_found', '学生不存在。');
      const now = this.now().toISOString();
      this.db.prepare('UPDATE students SET disabled_at = COALESCE(disabled_at, ?) WHERE id = ?').run(now, studentId);
      const invitations = this.db.prepare('UPDATE invitations SET expires_at = ? WHERE student_id = ? AND expires_at > ?').run(now, studentId, now);
      const sessions = this.db.prepare('UPDATE sessions SET revoked = 1 WHERE student_id = ? AND revoked = 0').run(studentId);
      this.db.exec('COMMIT');
      return { revokedSessions: Number(sessions.changes), expiredInvitations: Number(invitations.changes) };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  /**
   * 删除账号（不可恢复）：在同一事务里删注册表里该学生的会话、邀请码、登记资料和账号行，删掉整个学生目录后才提交。
   * 前提：① 已经 disable（停用后网关不会再为他启动 worker）；② 该学生没有正在运行的 worker——
   * 由 worker 自己写的 `.worker.pid` 判活（CLI 是另一个进程，停不了 worker；不靠「多久没活动」推断）。
   * 有 worker 还活着就拒绝：等它空闲退出，或在发布窗口重启/停止服务后再删。
   * 删除记录（日期 + 账号 ID，不含姓名手机号）追加到 hostDir/deletions.log。
   */
  deleteStudent(studentId: string): { removedDirectory: boolean } {
    if (!/^[0-9a-f-]{36}$/i.test(studentId)) throw new RegistryError('student_not_found', '学生不存在。');
    const dir = this.studentDir(studentId);
    let existed = false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT disabled_at FROM students WHERE id = ?').get(studentId) as { disabled_at: string | null } | undefined;
      if (!row) throw new RegistryError('student_not_found', '学生不存在。');
      if (row.disabled_at === null) throw new RegistryError('student_active', `请先运行 disable ${studentId}，再删除。`);
      const pid = liveWorkerPid(dir);
      if (pid !== null) {
        throw new RegistryError('student_active', `这个学生的进程还在运行（${pid > 0 ? `pid ${pid}` : `${WORKER_PID_FILE} 无法识别`}），现在删除会和它抢文件。`
          + '请等它空闲退出（缺省约 12 分钟；有识别任务时会更久），或停止服务（systemctl stop super-error-log）后再删。');
      }
      this.db.prepare('DELETE FROM sessions WHERE student_id = ?').run(studentId);
      this.db.prepare('DELETE FROM invitations WHERE student_id = ?').run(studentId);
      this.db.prepare('DELETE FROM student_registration WHERE student_id = ?').run(studentId);
      this.db.prepare('DELETE FROM students WHERE id = ?').run(studentId);
      // 先删目录、再提交：目录删不掉（例如里面有 root 属主的文件）时整笔回滚，账号行还在，
      // 修好权限后可以再执行一次 delete；不会出现「账号没了、学习数据还留在盘上、CLI 再也找不到」。
      existed = fs.existsSync(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    fs.appendFileSync(path.join(this.hostDir, 'deletions.log'), `${this.now().toISOString()} deleted ${studentId}\n`, { mode: 0o600 });
    return { removedDirectory: existed };
  }

  /**
   * 导出（个人信息查阅/复制请求）：在 outDir 下新建 <studentId>-<日期>/，含 account.json（登记资料、同意记录、
   * 邀请码与会话的元数据，不含任何码或令牌）和 data/（该学生目录的副本；SQLite 用 VACUUM INTO 得到一致快照）。
   * 目录 0700；调用方自己打包、核验身份后交给本人。
   */
  exportStudent(studentId: string, outDir: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(studentId) || !this.studentExists(studentId)) throw new RegistryError('student_not_found', '学生不存在。');
    const source = this.studentDir(studentId);
    // 先把输出目录换成真实路径（解开符号链接；目录还不存在时解开最近的已存在上级），
    // 再判断是否落在注册库目录或该学生目录里面：符号链接指进去的目标同样拒绝。
    const realOut = canonicalPath(outDir);
    const target = path.join(realOut, `${studentId}-${this.now().toISOString().slice(0, 10)}`);
    if (fs.existsSync(target)) throw new RegistryError('invalid_registration', `导出目录已存在：${target}`);
    for (const guarded of [this.hostDir, source]) {
      const real = canonicalPath(guarded);
      if (target === real || target.startsWith(real + path.sep) || real.startsWith(target + path.sep)) {
        throw new RegistryError('invalid_registration', '不要导出到学生空间目录里面（含指向那里的符号链接），请换一个目录。');
      }
    }
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    if (canonicalPath(target) !== target) throw new RegistryError('invalid_registration', '导出目录在创建过程中被替换，已停止。');
    fs.chmodSync(target, 0o700);
    const student = this.db.prepare('SELECT id, created_at, account_role, last_seen_at, disabled_at FROM students WHERE id = ?').get(studentId);
    const registration = this.db.prepare(`SELECT name, phone, consent_version, consent_at, age_band, guardian_consent, registration_code_id
      FROM student_registration WHERE student_id = ?`).get(studentId) ?? null;
    const invitations = this.db.prepare('SELECT public_id, created_at, expires_at, redeemed_at, reusable FROM invitations WHERE student_id = ? ORDER BY created_at').all(studentId);
    const sessions = this.db.prepare('SELECT created_at, expires_at, revoked, renewed_at FROM sessions WHERE student_id = ? ORDER BY created_at').all(studentId);
    fs.writeFileSync(path.join(target, 'account.json'), JSON.stringify({ exportedAt: this.now().toISOString(), student, registration, invitations, sessions }, null, 2), { mode: 0o600 });
    const dataTarget = path.join(target, 'data');
    fs.mkdirSync(dataTarget, { mode: 0o700 });
    if (fs.existsSync(source)) {
      const walk = (from: string, to: string): void => {
        for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
          const src = path.join(from, entry.name);
          const dst = path.join(to, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) { fs.mkdirSync(dst, { mode: 0o700 }); walk(src, dst); continue; }
          if (!entry.isFile() || /\.db-(?:wal|shm)$/.test(entry.name) || entry.name === WORKER_PID_FILE) continue;
          if (entry.name.endsWith('.db')) {
            const db = new DatabaseSync(src, { readOnly: true });
            try { db.prepare('VACUUM INTO ?').run(dst); } finally { db.close(); }
            fs.chmodSync(dst, 0o600);
          } else fs.copyFileSync(src, dst);
        }
      };
      walk(source, dataTarget);
    }
    return target;
  }

  close(): void {
    this.db.close();
  }
}
