// 运维脚本共用的小工具。只用 Node 24 自带模块，服务器上用 /opt/super-error-log/node-v24/bin/node 运行。
// 这些脚本由管理员复制到 /usr/local/lib/sel-ops（root 所有），不要直接从 releases/ 目录运行。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULTS = {
  dataDir: '/var/lib/super-error-log',
  backupDir: '/var/backups/super-error-log-daily',
  stateDir: '/var/lib/sel-ops',
  appUser: 'supererrorlog',
  node: '/opt/super-error-log/node-v24/bin/node',
  publicHost: 'study.pccoding666.com',
  connectHost: '127.0.0.1',
};

export function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

export function intEnv(name, fallback) {
  const raw = env(name, '');
  if (!raw) return fallback;
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`${name} 必须是非负数字`);
  return Number(raw);
}

export function hostDirOf(dataDir) {
  return env('SEL_OPS_HOST_DIR', path.join(dataDir, 'student-host'));
}

/** Asia/Shanghai 的日期 YYYY-MM-DD（与应用的“今天”一致）。 */
export function shanghaiDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export const SNAPSHOT_NAME = /^\d{4}-\d{2}-\d{2}$/;
export const SQLITE_NAME = /\.(db|sqlite)$/;
export const SQLITE_SIDECAR = /\.(db|sqlite)-(wal|shm|journal)$/;
/** 备份里绝不带的东西：env 文件和 TLS 私钥（它们单独放密码管理器 / 证书目录）。 */
export const SECRET_NAME = /(^|\.)env$|^\.env(\..*)?$|\.(pem|key|p12|pfx)$/i;
export const SECRET_DIR = /^(tls|tls-.*|certificates)$/i;

/** 递归列出 root 下的普通文件（不跟随软链，不进 SECRET_DIR）。返回相对路径。 */
export function walk(root, { onSkip } = {}) {
  const out = [];
  const visit = relative => {
    const absolute = path.join(root, relative);
    let entries;
    try { entries = fs.readdirSync(absolute, { withFileTypes: true }); }
    catch (error) { onSkip?.(relative, `unreadable:${error.code ?? 'error'}`); return; }
    for (const entry of entries) {
      const rel = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isSymbolicLink()) { onSkip?.(rel, 'symlink'); continue; }
      if (entry.isDirectory()) {
        if (SECRET_DIR.test(entry.name)) { onSkip?.(rel, 'secret'); continue; }
        visit(rel);
      } else if (entry.isFile()) out.push(rel);
      else onSkip?.(rel, 'special');
    }
  };
  visit('');
  return out.sort();
}

export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

export function isSqlite(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const header = Buffer.alloc(16);
      return fs.readSync(fd, header, 0, 16, 0) === 16 && header.toString('latin1') === 'SQLite format 3\u0000';
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

export function openReadOnly(file) {
  return new DatabaseSync(file, { readOnly: true, timeout: 5000 });
}

export function hasTable(db, name) {
  return !!db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

export function integrity(file) {
  const db = openReadOnly(file);
  try { return db.prepare('PRAGMA integrity_check').get()?.integrity_check ?? 'unknown'; }
  finally { db.close(); }
}

export function writeJsonAtomic(file, value, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
}

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function log(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ event, at: new Date().toISOString(), ...fields })}\n`);
}

export function parseArgs(argv) {
  const flags = new Set(); const values = {}; const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const [key, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) values[key] = inline;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--') && ['from', 'target', 'date', 'dir'].includes(key)) values[key] = argv[++i];
    else flags.add(key);
  }
  return { flags, values, positional };
}

/** 作为脚本直接运行（而不是被测试 import）时为 true。 */
export function isMain(metaUrl) {
  try { return fs.realpathSync(new URL(metaUrl)) === fs.realpathSync(process.argv[1] ?? ''); } catch { return false; }
}
