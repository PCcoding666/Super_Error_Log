#!/usr/bin/env node
// 每日备份：SQLite 在线一致备份 + 照片等文件按天硬链接增量，保留 14 天，再推到异地（OSS 或另一台主机）。
//
//   sel-backup.mjs snapshot [--dry-run]   以应用用户（supererrorlog）运行：生成 <备份目录>/<YYYY-MM-DD>/
//   sel-backup.mjs push     [--dry-run]   以 root 运行：把当天快照推到 SEL_BACKUP_REMOTE（不打开任何 SQLite）
//
// 环境变量（/etc/super-error-log/ops.env，见 ops.env.example）：
//   SEL_OPS_DATA_DIR      数据目录，缺省 /var/lib/super-error-log
//   SEL_BACKUP_DIR        本机备份目录，缺省 /var/backups/super-error-log-daily
//   SEL_BACKUP_KEEP_DAYS  本机保留天数，缺省 14
//   SEL_BACKUP_REMOTE     异地目标：oss://桶/前缀  或  rsync:用户@主机:/路径  或  none（不推，健康检查会每天提醒）
//   SEL_OSSUTIL           ossutil 路径，缺省 /usr/local/bin/ossutil（凭据在 root 的 ~/.ossutilconfig，不放 env）
//   SEL_RSYNC             rsync 路径，缺省 /usr/bin/rsync（ssh 私钥在 root 的 ~/.ssh，不放 env）
//
// 不备份：env 文件、TLS 私钥、SQLite 的 -wal/-shm（备份 API 已经把 WAL 里的内容写进副本）。
// --dry-run：只打印要做什么，不写任何文件、不推送。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import {
  DEFAULTS, SECRET_NAME, isMain, SNAPSHOT_NAME, SQLITE_NAME, SQLITE_SIDECAR, env, hasTable, integrity, intEnv, isSqlite, log, openReadOnly,
  parseArgs, readJson, sha256File, shanghaiDay, walk, writeJsonAtomic,
} from './lib.mjs';

export function config() {
  return {
    dataDir: path.resolve(env('SEL_OPS_DATA_DIR', DEFAULTS.dataDir)),
    backupDir: path.resolve(env('SEL_BACKUP_DIR', DEFAULTS.backupDir)),
    keepDays: intEnv('SEL_BACKUP_KEEP_DAYS', 14),
    remote: env('SEL_BACKUP_REMOTE', 'none'),
    ossutil: env('SEL_OSSUTIL', '/usr/local/bin/ossutil'),
    rsync: env('SEL_RSYNC', '/usr/bin/rsync'),
  };
}

function previousSnapshot(backupDir, today) {
  if (!fs.existsSync(backupDir)) return null;
  const names = fs.readdirSync(backupDir).filter(name => SNAPSHOT_NAME.test(name) && name < today).sort();
  return names.length ? path.join(backupDir, names.at(-1)) : null;
}

function sameFile(a, b) {
  // utimes 经浮点秒写回，毫秒以下会有误差：容忍 2 ms。
  return a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 2;
}

/** 生成当天快照。返回摘要（也写进 manifest.json 和 last-status.json）。 */
export async function snapshot(cfg = config(), { dryRun = false, now = new Date() } = {}) {
  const day = shanghaiDay(now);
  const final = path.join(cfg.backupDir, day);
  const work = path.join(cfg.backupDir, `.${day}.partial`);
  const previous = previousSnapshot(cfg.backupDir, day);
  const summary = { day, createdAt: now.toISOString(), dataDir: cfg.dataDir, dryRun, databases: [], files: 0, linked: 0, copied: 0, bytesCopied: 0, skipped: {}, ok: false };
  const skip = (_rel, reason) => { summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1; };
  if (!fs.existsSync(cfg.dataDir)) throw new Error(`数据目录不存在：${cfg.dataDir}`);
  const files = walk(cfg.dataDir, { onSkip: skip });
  if (!dryRun) {
    fs.mkdirSync(cfg.backupDir, { recursive: true, mode: 0o700 });
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(path.join(work, 'files'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(work, 'db'), { recursive: true, mode: 0o700 });
  }
  const failures = [];
  for (const rel of files) {
    const base = path.basename(rel);
    const source = path.join(cfg.dataDir, rel);
    if (SECRET_NAME.test(base)) { skip(rel, 'secret'); continue; }
    if (SQLITE_SIDECAR.test(base) || base.endsWith('.sock')) { skip(rel, 'sidecar'); continue; }
    if (SQLITE_NAME.test(base) && isSqlite(source)) {
      const target = path.join(work, 'db', rel);
      const entry = { path: rel, bytes: null, sha256: null, integrity: null, errorItems: null };
      if (dryRun) { log('backup_plan', { action: 'sqlite_backup', path: rel }); summary.databases.push(entry); continue; }
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        const db = openReadOnly(source);
        try { await sqliteBackup(db, target); } finally { db.close(); }
        // 副本改成单文件（DELETE 模式）：之后只读打开不会再生成 -wal/-shm，推送/恢复都只有一个文件。
        const own = new DatabaseSync(target);
        try { own.exec('PRAGMA journal_mode = DELETE'); } finally { own.close(); }
        fs.chmodSync(target, 0o600);
        entry.integrity = integrity(target);
        entry.bytes = fs.statSync(target).size;
        entry.sha256 = sha256File(target);
        const copy = openReadOnly(target);
        try { if (hasTable(copy, 'error_item')) entry.errorItems = copy.prepare('SELECT COUNT(*) AS n FROM error_item').get().n; }
        finally { copy.close(); }
        if (entry.integrity !== 'ok') failures.push(`${rel}: integrity ${entry.integrity}`);
      } catch (error) {
        entry.integrity = 'failed';
        failures.push(`${rel}: ${error instanceof Error ? error.message.slice(0, 200) : 'backup failed'}`);
      }
      summary.databases.push(entry);
      continue;
    }
    summary.files += 1;
    const stat = fs.statSync(source);
    const prior = previous ? path.join(previous, 'files', rel) : null;
    let link = false;
    if (prior) { try { link = sameFile(fs.statSync(prior), stat); } catch { link = false; } }
    if (dryRun) { if (!link) { summary.copied += 1; summary.bytesCopied += stat.size; } else summary.linked += 1; continue; }
    const target = path.join(work, 'files', rel);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (link) {
      try { fs.linkSync(prior, target); summary.linked += 1; continue; } catch { /* 跨盘或链接数满：退回复制 */ }
    }
    try {
      fs.copyFileSync(source, target);
      fs.chmodSync(target, 0o600);
      fs.utimesSync(target, stat.atime, stat.mtime);
      summary.copied += 1; summary.bytesCopied += stat.size;
    } catch (error) {
      if (error?.code === 'ENOENT') { skip(rel, 'vanished'); summary.files -= 1; continue; } // 读的时候刚被删掉
      failures.push(`${rel}: ${error?.code ?? 'copy failed'}`);
    }
  }
  summary.ok = failures.length === 0;
  summary.failures = failures.slice(0, 20);
  summary.finishedAt = new Date().toISOString();
  if (dryRun) { log('backup_dry_run', summary); return summary; }
  writeJsonAtomic(path.join(work, 'manifest.json'), summary);
  if (summary.ok) {
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(work, final);
  }
  summary.pruned = prune(cfg, now);
  writeJsonAtomic(path.join(cfg.backupDir, 'last-status.json'), { ok: summary.ok, day, finishedAt: summary.finishedAt, databases: summary.databases.length,
    files: summary.files, copied: summary.copied, linked: summary.linked, failures: summary.failures });
  log(summary.ok ? 'backup_ok' : 'backup_failed', { day, databases: summary.databases.length, files: summary.files, copied: summary.copied, linked: summary.linked, failures: summary.failures });
  return summary;
}

/** 删除超过保留天数的快照（只认 YYYY-MM-DD 名字的真实目录）和昨天以前残留的 .partial。 */
export function prune(cfg, now = new Date(), { dryRun = false } = {}) {
  if (!fs.existsSync(cfg.backupDir)) return [];
  const cutoff = shanghaiDay(new Date(now.getTime() - cfg.keepDays * 86_400_000));
  const today = shanghaiDay(now);
  const removed = [];
  for (const entry of fs.readdirSync(cfg.backupDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const partial = /^\.(\d{4}-\d{2}-\d{2})\.partial$/.exec(entry.name);
    const old = (SNAPSHOT_NAME.test(entry.name) && entry.name <= cutoff) || (partial && partial[1] < today);
    if (!old) continue;
    if (!dryRun) fs.rmSync(path.join(cfg.backupDir, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

/** 组装推送命令（不经过 shell）。 */
export function pushCommand(cfg, day) {
  const source = path.join(cfg.backupDir, day);
  if (cfg.remote === 'none') return null;
  if (cfg.remote.startsWith('oss://')) {
    const target = `${cfg.remote.replace(/\/+$/, '')}/${day}/`;
    return [cfg.ossutil, ['cp', '-r', '-u', '-f', `${source}/`, target]];
  }
  if (cfg.remote.startsWith('rsync:')) {
    // 镜像整个备份目录（-H 保留硬链接，--delete 让远端也只留 14 天）。
    const target = `${cfg.remote.slice('rsync:'.length).replace(/\/+$/, '')}/`;
    return [cfg.rsync, ['-aH', '--delete', '--exclude=.*.partial', '--exclude=last-*.json', '-e', 'ssh -o BatchMode=yes -o ConnectTimeout=20', `${cfg.backupDir}/`, target]];
  }
  throw new Error('SEL_BACKUP_REMOTE 只支持 oss://桶/前缀、rsync:用户@主机:/路径 或 none');
}

export function push(cfg = config(), { dryRun = false, now = new Date(), runner = spawnSync } = {}) {
  const status = readJson(path.join(cfg.backupDir, 'last-status.json'));
  const day = status?.day ?? shanghaiDay(now);
  const result = { day, remote: cfg.remote.replace(/\/\/[^/]*@/, '//***@'), ok: false, finishedAt: null, reason: null };
  const command = pushCommand(cfg, day);
  if (!command) result.reason = 'not_configured';
  else if (!status?.ok || !fs.existsSync(path.join(cfg.backupDir, day))) result.reason = 'no_snapshot';
  else if (dryRun) { log('push_plan', { command: [command[0], ...command[1]] }); result.ok = true; result.reason = 'dry_run'; }
  else {
    const run = runner(command[0], command[1], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 3 * 60 * 60 * 1000 });
    result.ok = run.status === 0;
    if (!result.ok) result.reason = run.error ? `spawn:${run.error.code ?? 'error'}` : `exit:${run.status}`;
  }
  result.finishedAt = new Date().toISOString();
  if (!dryRun) writeJsonAtomic(path.join(cfg.backupDir, 'last-push.json'), result, 0o644);
  log(result.ok ? 'push_ok' : 'push_failed', result);
  return result;
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const dryRun = flags.has('dry-run');
  const cfg = config();
  if (positional[0] === 'snapshot') { const s = await snapshot(cfg, { dryRun }); process.exitCode = s.ok ? 0 : 1; return; }
  if (positional[0] === 'push') {
    const r = push(cfg, { dryRun });
    // 没配异地不让 systemd 报失败（健康检查每天会提醒），真推送失败才非 0。
    process.exitCode = r.ok || r.reason === 'not_configured' ? 0 : 1;
    return;
  }
  if (positional[0] === 'prune') { log('prune', { removed: prune(cfg, new Date(), { dryRun }) }); return; }
  process.stderr.write('用法：sel-backup.mjs snapshot|push|prune [--dry-run]\n');
  process.exitCode = 2;
}

if (isMain(import.meta.url)) await main();
