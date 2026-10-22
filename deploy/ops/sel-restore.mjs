#!/usr/bin/env node
// 从每日快照恢复。缺省是“演练”：恢复到一个新的空目录，逐个库做 integrity_check，数一数错题，打印用时。
//
//   演练：sel-restore.mjs --from /var/backups/super-error-log-daily/2026-10-22 --target /tmp/sel-restore-drill
//   真恢复（先停服务！）：
//         systemctl stop super-error-log
//         sel-restore.mjs --from <快照目录> --target /var/lib/super-error-log --live --confirm-service-stopped
//
// 真恢复不会删除现有数据：现有目录整体改名为 <target>.before-restore-<时间>，确认无误后由人决定是否删除。
// 从 OSS 恢复时先把快照下载到本机目录（命令见 RUNBOOK.md），再用 --from 指向它。
// --dry-run：只检查快照、打印计划，不写任何文件。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { hasTable, integrity, isMain, log, openReadOnly, parseArgs, readJson, sha256File, walk } from './lib.mjs';

export function verifySnapshot(from) {
  const manifest = readJson(path.join(from, 'manifest.json'));
  if (!manifest || manifest.ok !== true || !Array.isArray(manifest.databases)) throw new Error('快照缺少有效的 manifest.json（或那次备份没有成功）');
  const problems = [];
  for (const entry of manifest.databases) {
    const file = path.join(from, 'db', entry.path);
    if (!fs.existsSync(file)) { problems.push(`${entry.path}: 缺失`); continue; }
    if (entry.sha256 && sha256File(file) !== entry.sha256) problems.push(`${entry.path}: 校验和不一致`);
  }
  if (problems.length) throw new Error(`快照不完整：${problems.slice(0, 5).join('；')}`);
  return manifest;
}

function copyTree(fromRoot, toRoot) {
  let count = 0;
  for (const rel of walk(fromRoot)) {
    const target = path.join(toRoot, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(fromRoot, rel), target); // 复制而不是硬链接：恢复后的文件不能和备份共用 inode
    fs.chmodSync(target, 0o600);
    const stat = fs.statSync(path.join(fromRoot, rel));
    fs.utimesSync(target, stat.atime, stat.mtime);
    count += 1;
  }
  return count;
}

export function restore({ from, target, live = false, confirmStopped = false, dryRun = false, serviceActive = defaultServiceActive, now = new Date() }) {
  const started = Date.now();
  if (!from || !target) throw new Error('需要 --from <快照目录> 和 --target <恢复到哪里>');
  from = path.resolve(from); target = path.resolve(target);
  const manifest = verifySnapshot(from);
  const exists = fs.existsSync(target) && fs.readdirSync(target).length > 0;
  let movedAside = null;
  if (exists && !live) throw new Error(`目标目录不是空的：${target}。演练请用新的空目录；真恢复要加 --live --confirm-service-stopped`);
  if (live) {
    if (!confirmStopped) throw new Error('真恢复必须先停服务，并加 --confirm-service-stopped');
    if (serviceActive()) throw new Error('super-error-log 服务还在运行，先 systemctl stop super-error-log');
  }
  const plan = { from, target, databases: manifest.databases.length, snapshotDay: manifest.day, moveAside: exists };
  if (dryRun) { log('restore_plan', plan); return { ...plan, dryRun: true }; }
  if (exists) {
    movedAside = `${target}.before-restore-${now.toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(target, movedAside);
  }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const files = fs.existsSync(path.join(from, 'files')) ? copyTree(path.join(from, 'files'), target) : 0;
  const databases = copyTree(path.join(from, 'db'), target);
  const checks = [];
  let errorItems = 0;
  for (const entry of manifest.databases) {
    const file = path.join(target, entry.path);
    const result = integrity(file);
    let items = null;
    const db = openReadOnly(file);
    try { if (hasTable(db, 'error_item')) items = db.prepare('SELECT COUNT(*) AS n FROM error_item').get().n; } finally { db.close(); }
    if (items !== null) errorItems += items;
    checks.push({ path: entry.path, integrity: result, errorItems: items, expectedErrorItems: entry.errorItems ?? null });
  }
  // 以 root 恢复到线上目录时，属主改回原目录的属主（应用用户），否则服务起来读写不了。
  // 放在检查之后：检查时打开库可能新建 -wal/-shm，也要一起改。
  if (movedAside && typeof process.getuid === 'function' && process.getuid() === 0) {
    const owner = fs.statSync(movedAside);
    const chown = dir => { fs.chownSync(dir, owner.uid, owner.gid); for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) chown(p); else fs.chownSync(p, owner.uid, owner.gid); } };
    chown(target);
  }
  const bad = checks.filter(check => check.integrity !== 'ok' || (check.expectedErrorItems !== null && check.errorItems !== check.expectedErrorItems));
  const summary = { ...plan, files, databases, errorItems, movedAside, ok: bad.length === 0, problems: bad.slice(0, 10), seconds: Math.round((Date.now() - started) / 1000) };
  log(summary.ok ? 'restore_ok' : 'restore_problems', summary);
  return summary;
}

function defaultServiceActive() {
  const result = spawnSync('/usr/bin/systemctl', ['is-active', '--quiet', 'super-error-log']);
  return result.status === 0;
}

if (isMain(import.meta.url)) {
  const { flags, values } = parseArgs(process.argv.slice(2));
  try {
    const result = restore({ from: values.from, target: values.target, live: flags.has('live'), confirmStopped: flags.has('confirm-service-stopped'), dryRun: flags.has('dry-run') });
    process.exitCode = result.dryRun || result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`恢复没有进行：${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
