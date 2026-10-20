import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const hash = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');
interface Credential { salt: string; password_hash: string; generation: string }

/** Separate from invitation authentication. No default credentials or student fallback. */
export class AdminAuth {
  private constructor(private readonly db: DatabaseSync, private readonly now: () => number) {}

  static open(hostDir: string, options: { now?: () => number } = {}): AdminAuth {
    fs.mkdirSync(hostDir, { recursive: true, mode: 0o700 });
    const filename = path.join(hostDir, 'admin.db');
    const db = new DatabaseSync(filename);
    fs.chmodSync(filename, 0o600);
    db.exec(`PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS admin_credential (
        id INTEGER PRIMARY KEY CHECK(id = 1), salt TEXT NOT NULL, password_hash TEXT NOT NULL, generation TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_session (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    `);
    return new AdminAuth(db, options.now ?? Date.now);
  }

  /** Server-only bootstrap/reset. Returned password is shown once by the administrator CLI. */
  rotatePassword(): string {
    const password = crypto.randomBytes(24).toString('base64url');
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync(password, salt, 64).toString('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR REPLACE INTO admin_credential (id, salt, password_hash, generation) VALUES (1, ?, ?, ?)')
        .run(salt, derived, crypto.randomUUID());
      this.db.exec('DELETE FROM admin_session; COMMIT;');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return password;
  }

  async login(password: string): Promise<string | null> {
    if (!password || password.length > 256) return null;
    const credential = this.db.prepare('SELECT salt, password_hash, generation FROM admin_credential WHERE id = 1').get() as unknown as Credential | undefined;
    if (!credential) return null;
    const derived = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(password, credential.salt, 64, (error, key) => error ? reject(error) : resolve(key));
    });
    const expected = Buffer.from(credential.password_hash, 'hex');
    if (expected.length !== derived.length || !crypto.timingSafeEqual(expected, derived)) return null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // A reset racing with async scrypt must not issue a new session for an old password.
      const current = this.db.prepare('SELECT generation FROM admin_credential WHERE id = 1').get() as { generation: string } | undefined;
      if (current?.generation !== credential.generation) { this.db.exec('ROLLBACK'); return null; }
      this.db.prepare('DELETE FROM admin_session WHERE expires_at <= ?').run(this.now());
      const token = crypto.randomBytes(32).toString('base64url');
      this.db.prepare('INSERT INTO admin_session (token_hash, expires_at) VALUES (?, ?)').run(hash(token), this.now() + ADMIN_SESSION_TTL_MS);
      this.db.exec('COMMIT');
      return token;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  authenticate(token: string): boolean {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const session = this.db.prepare('SELECT expires_at FROM admin_session WHERE token_hash = ?').get(hash(token)) as { expires_at: number } | undefined;
    return !!session && session.expires_at > this.now();
  }

  logout(token: string): void {
    if (/^[A-Za-z0-9_-]{43}$/.test(token)) this.db.prepare('DELETE FROM admin_session WHERE token_hash = ?').run(hash(token));
  }

  close(): void { this.db.close(); }
}
