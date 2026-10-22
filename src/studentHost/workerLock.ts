/**
 * 学生 worker 的存活标记（2026-10-22，PR #55 评审）：worker 启动时在自己的学生目录写 `.worker.pid`，退出时删掉。
 * 管理 CLI 是另一个进程，停不了 worker；删除账号前用它确认这个学生没有正在运行的 worker
 * （否则 worker 还开着该目录里的 SQLite 文件，删目录会和它抢文件）。
 * - 判活：`process.kill(pid, 0)`；ESRCH = 已退出，其他（含 EPERM）一律按「还活着」处理，宁可拒绝删除。
 * - 防 pid 复用误判：Linux 上再看 /proc/<pid>/cmdline 是否像我们的 worker；读不到时仍按活着处理。
 */
import fs from 'node:fs';
import path from 'node:path';

export const WORKER_PID_FILE = '.worker.pid';

interface PidRecord { pid: number; startedAt: string }

export function writeWorkerPid(studentDir: string, pid = process.pid): void {
  const file = path.join(studentDir, WORKER_PID_FILE);
  const temp = `${file}.${pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ pid, startedAt: new Date().toISOString() } satisfies PidRecord), { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** 只删自己写的那一份（新 worker 可能已经覆盖成别的 pid）。 */
export function clearWorkerPid(studentDir: string, pid = process.pid): void {
  const file = path.join(studentDir, WORKER_PID_FILE);
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as PidRecord;
    if (record.pid === pid) fs.rmSync(file, { force: true });
  } catch { /* 没有或已损坏：无需处理 */ }
}

function looksLikeOurWorker(pid: number): boolean {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return /worker\.(?:js|ts)/.test(cmdline);
  } catch (error) {
    // /proc 里没有这个进程 = 已退出；没有 /proc（非 Linux）或读不了 = 无法排除，按活着处理。
    return (error as NodeJS.ErrnoException).code !== 'ENOENT' || !fs.existsSync('/proc/self');
  }
}

/** 该学生目录里还在运行的 worker 的 pid；没有返回 null。损坏的标记文件按「可能还在运行」处理（返回 -1）。 */
export function liveWorkerPid(studentDir: string): number | null {
  const file = path.join(studentDir, WORKER_PID_FILE);
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let record: PidRecord;
  try { record = JSON.parse(raw) as PidRecord; } catch { return -1; }
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return -1;
  try { process.kill(record.pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return null;
    return record.pid;
  }
  return looksLikeOurWorker(record.pid) ? record.pid : null;
}
