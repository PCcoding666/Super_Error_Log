// deploy/ops 运维脚本的本机测试（合成数据、临时目录；不碰 systemd、journald、网络）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const OPS = path.resolve(__dirname, '../../deploy/ops');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const load = async (name: string): Promise<Any> => import(pathToFileURL(path.join(OPS, name)).href);

let root: string; let data: string; let backups: string;
const savedEnv = { ...process.env };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-ops-'));
  data = path.join(root, 'data'); backups = path.join(root, 'backups');
  const student = path.join(data, 'student-host/students/0000aaaa-synthetic');
  fs.mkdirSync(path.join(student, 'photos'), { recursive: true });
  fs.writeFileSync(path.join(student, 'photos/page-1.jpg'), Buffer.from('synthetic-jpeg-1'));
  fs.writeFileSync(path.join(student, 'photos/page-2.jpg'), Buffer.from('synthetic-jpeg-2'));
  const registry = new DatabaseSync(path.join(data, 'student-host/registry.db'));
  registry.exec("CREATE TABLE students (id TEXT PRIMARY KEY, created_at TEXT NOT NULL); INSERT INTO students VALUES ('0000aaaa-synthetic', '2026-10-01T00:00:00.000Z');");
  registry.close();
  fs.writeFileSync(path.join(data, 'env'), 'SEL_AI_API_KEY=fake-secret');
  fs.writeFileSync(path.join(data, 'server.key'), 'fake-private-key');
  fs.mkdirSync(path.join(data, 'tls-ip')); fs.writeFileSync(path.join(data, 'tls-ip/key.pem'), 'fake-pem');
  process.env.SEL_OPS_DATA_DIR = data; process.env.SEL_BACKUP_DIR = backups; process.env.SEL_BACKUP_KEEP_DAYS = '14';
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(root, { recursive: true, force: true });
});

/** 一个 WAL 模式的学生库：最后一条写入还在 WAL 里没合并，备份必须带上它。 */
function studentDb(): DatabaseSync {
  const db = new DatabaseSync(path.join(data, 'student-host/students/0000aaaa-synthetic/app.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE error_item (id TEXT); CREATE TABLE material_job (id TEXT, state TEXT, updated_at TEXT);');
  db.exec("INSERT INTO error_item VALUES ('合成错题1'), ('合成错题2'), ('合成错题3')");
  return db;
}

describe('daily backup snapshot', () => {
  it('copies SQLite consistently (including WAL content), hardlinks unchanged photos, never copies env or private keys', async () => {
    const { snapshot, config } = await load('sel-backup.mjs');
    const live = studentDb();
    try {
      const day1 = await snapshot(config(), { now: new Date('2026-10-21T19:40:00.000Z') }); // 10-22 03:40 Shanghai
      expect(day1.ok).toBe(true);
      const dir = path.join(backups, '2026-10-22');
      const copy = new DatabaseSync(path.join(dir, 'db/student-host/students/0000aaaa-synthetic/app.db'), { readOnly: true });
      expect((copy.prepare('SELECT COUNT(*) AS n FROM error_item').get() as { n: number }).n).toBe(3);
      copy.close();
      expect(day1.databases.map((d: Any) => d.integrity)).toEqual(['ok', 'ok']);
      const all = walkAll(dir).join('\n');
      expect(all).toContain('files/student-host/students/0000aaaa-synthetic/photos/page-1.jpg');
      expect(all).not.toMatch(/(^|\/)env$|server\.key|key\.pem|tls-ip|-wal|-shm/m);
      expect(JSON.parse(fs.readFileSync(path.join(backups, 'last-status.json'), 'utf8'))).toMatchObject({ ok: true, day: '2026-10-22' });

      fs.writeFileSync(path.join(data, 'student-host/students/0000aaaa-synthetic/photos/page-2.jpg'), Buffer.from('synthetic-jpeg-2-changed!'));
      live.exec("INSERT INTO error_item VALUES ('合成错题4')");
      const day2 = await snapshot(config(), { now: new Date('2026-10-22T19:40:00.000Z') });
      expect(day2).toMatchObject({ ok: true, linked: 1, copied: 1 });
      const inode = (d: string, f: string) => fs.statSync(path.join(backups, d, 'files/student-host/students/0000aaaa-synthetic/photos', f)).ino;
      expect(inode('2026-10-23', 'page-1.jpg')).toBe(inode('2026-10-22', 'page-1.jpg'));
      expect(inode('2026-10-23', 'page-2.jpg')).not.toBe(inode('2026-10-22', 'page-2.jpg'));
    } finally { live.close(); }
  });

  it('keeps 14 days and only removes snapshot-named directories', async () => {
    const { prune, config } = await load('sel-backup.mjs');
    for (const name of ['2026-10-01', '2026-10-08', '2026-10-09', '2026-10-21', 'notes']) fs.mkdirSync(path.join(backups, name), { recursive: true });
    fs.mkdirSync(path.join(backups, '.2026-10-20.partial'));
    const removed = prune(config(), new Date('2026-10-22T19:40:00.000Z')); // today = 10-23
    expect(removed.sort()).toEqual(['.2026-10-20.partial', '2026-10-01', '2026-10-08', '2026-10-09']);
    expect(fs.readdirSync(backups).sort()).toEqual(['2026-10-21', 'notes']);
  });

  it('--dry-run writes nothing (CLI)', () => {
    const result = spawnSync(process.execPath, [path.join(OPS, 'sel-backup.mjs'), 'snapshot', '--dry-run'], { env: process.env, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('backup_dry_run');
    expect(fs.existsSync(backups)).toBe(false);
  });

  it('builds off-site push commands without a shell, and records a failed push', async () => {
    const { pushCommand, push, config, snapshot } = await load('sel-backup.mjs');
    const cfg = config();
    expect(pushCommand({ ...cfg, remote: 'none' }, '2026-10-22')).toBeNull();
    expect(pushCommand({ ...cfg, remote: 'oss://sel-backup-bucket/prod/' }, '2026-10-22'))
      .toEqual(['/usr/local/bin/ossutil', ['cp', '-r', '-u', '-f', `${backups}/2026-10-22/`, 'oss://sel-backup-bucket/prod/2026-10-22/']]);
    const rsync = pushCommand({ ...cfg, remote: 'rsync:backup@backup-host.invalid:/srv/sel' }, '2026-10-22');
    expect(rsync[1]).toEqual(expect.arrayContaining(['-aH', '--delete', `${backups}/`, 'backup@backup-host.invalid:/srv/sel/']));
    expect(() => pushCommand({ ...cfg, remote: 'ftp://x' }, 'd')).toThrow();
    studentDb().close();
    await snapshot(cfg, { now: new Date('2026-10-21T19:40:00.000Z') });
    const calls: Any[] = [];
    const failed = push({ ...cfg, remote: 'oss://sel-backup-bucket/prod' }, { runner: (cmd: string, args: string[]) => { calls.push([cmd, args]); return { status: 1 }; } });
    expect(failed).toMatchObject({ ok: false, reason: 'exit:1', day: '2026-10-22' });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(backups, 'last-push.json'), 'utf8'))).toMatchObject({ ok: false });
    expect(push({ ...cfg, remote: 'none' })).toMatchObject({ ok: false, reason: 'not_configured' });
  });
});

describe('restore', () => {
  async function snapshotDir(): Promise<string> {
    const { snapshot, config } = await load('sel-backup.mjs');
    studentDb().close();
    await snapshot(config(), { now: new Date('2026-10-21T19:40:00.000Z') });
    return path.join(backups, '2026-10-22');
  }

  it('drill: restores into an empty directory, checks integrity and counts error items', async () => {
    const { restore } = await load('sel-restore.mjs');
    const from = await snapshotDir();
    const target = path.join(root, 'drill');
    const result = restore({ from, target });
    expect(result).toMatchObject({ ok: true, databases: 2, files: 2, errorItems: 3, movedAside: null });
    expect(fs.readFileSync(path.join(target, 'student-host/students/0000aaaa-synthetic/photos/page-1.jpg'), 'utf8')).toBe('synthetic-jpeg-1');
    expect(fs.statSync(path.join(target, 'student-host/students/0000aaaa-synthetic/photos/page-1.jpg')).ino)
      .not.toBe(fs.statSync(path.join(from, 'files/student-host/students/0000aaaa-synthetic/photos/page-1.jpg')).ino);
  });

  it('refuses a non-empty target, requires a stopped service for live restore, and never deletes existing data', async () => {
    const { restore } = await load('sel-restore.mjs');
    const from = await snapshotDir();
    expect(() => restore({ from, target: data })).toThrow(/不是空的/);
    expect(() => restore({ from, target: data, live: true })).toThrow(/confirm-service-stopped/);
    expect(() => restore({ from, target: data, live: true, confirmStopped: true, serviceActive: () => true })).toThrow(/还在运行/);
    expect(restore({ from, target: data, live: true, confirmStopped: true, serviceActive: () => false, dryRun: true })).toMatchObject({ dryRun: true });
    const result = restore({ from, target: data, live: true, confirmStopped: true, serviceActive: () => false, now: new Date('2026-10-23T01:00:00.000Z') });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(result.movedAside, 'env'))).toBe(true); // 旧目录整体保留
    expect(fs.existsSync(path.join(data, 'env'))).toBe(false); // 密钥不在备份里，也不会被“恢复”出来
  });

  it('as root, always hands restored files to the app user — also for a missing or empty live target', async () => {
    const { restore } = await load('sel-restore.mjs');
    const from = await snapshotDir();
    for (const prepare of ['missing', 'empty'] as const) {
      const target = path.join(root, `live-${prepare}`);
      if (prepare === 'empty') fs.mkdirSync(target);
      const chowned: Array<[string, number, number]> = [];
      const result = restore({ from, target, live: true, confirmStopped: true, serviceActive: () => false, isRoot: () => true,
        resolveOwner: () => ({ uid: 4242, gid: 4343 }), chown: (p: string, uid: number, gid: number) => { chowned.push([p, uid, gid]); } });
      expect(result.ok).toBe(true);
      expect(result.movedAside).toBeNull();
      const expected = [target, ...walkAll(target).map(rel => path.join(target, rel))];
      for (const dir of new Set(walkAll(target).map(rel => path.dirname(path.join(target, rel))))) expected.push(dir);
      for (const p of new Set(expected)) expect(chowned).toContainEqual([p, 4242, 4343]);
      expect(chowned.every(([, uid, gid]) => uid === 4242 && gid === 4343)).toBe(true);
    }
    expect(() => restore({ from, target: path.join(root, 'live-nouser'), live: true, confirmStopped: true, serviceActive: () => false,
      isRoot: () => true, resolveOwner: () => null, chown: () => undefined })).toThrow(/查不到应用用户/);
    expect(fs.existsSync(path.join(root, 'live-nouser'))).toBe(false);
  });

  it('rejects a tampered snapshot', async () => {
    const { restore } = await load('sel-restore.mjs');
    const from = await snapshotDir();
    fs.appendFileSync(path.join(from, 'db/student-host/registry.db'), 'x');
    expect(() => restore({ from, target: path.join(root, 'drill') })).toThrow(/校验和不一致/);
  });
});

describe('health check and alert push', () => {
  let server: http.Server; let url: string; let body = '<label>邀请码</label>'; let status = 200;
  beforeEach(async () => {
    server = http.createServer((_req, res) => { res.writeHead(status); res.end(body); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/s/`;
    Object.assign(process.env, { SEL_OPS_HEALTH_URL: url, SEL_OPS_SKIP: 'systemd,journal,cert', SEL_OPS_STATE_DIR: path.join(root, 'state'),
      SEL_ALERT_DISK_MIN_GIB: '0', SEL_ALERT_DISK_MAX_PCT: '100', SEL_ALERT_QUEUE_MAX: '2' });
  });
  afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); body = '<label>邀请码</label>'; status = 200; });

  function aiUsage(rows: Array<[string, string]>, now: Date): void {
    const db = new DatabaseSync(path.join(data, 'student-host/students/0000aaaa-synthetic/ai-usage.db'));
    db.exec('CREATE TABLE ai_usage (id TEXT, started_at TEXT, provider TEXT, status TEXT, duration_ms INTEGER)');
    rows.forEach(([provider, s], i) => db.prepare('INSERT INTO ai_usage VALUES (?, ?, ?, ?, ?)').run(String(i), new Date(now.getTime() - 60_000).toISOString(), provider, s, 1000));
    db.close();
  }

  it('reports queue backlog, AI failure rate, stale backup and a broken login page; dedups and announces recovery', async () => {
    const { check, config, collectStats } = await load('sel-healthcheck.mjs');
    const now = new Date('2026-10-22T12:00:00.000Z');
    const live = studentDb();
    live.exec("INSERT INTO material_job VALUES ('1','queued','x'),('2','queued','x'),('3','running','x')");
    live.close();
    aiUsage([['bailian-token-plan', 'failed'], ['bailian-token-plan', 'failed'], ['bailian', 'succeeded'], ['bailian-token-plan', 'succeeded'], ['bailian-token-plan', 'failed']], now);
    const cfg = config();
    const stats = collectStats(cfg.hostDir, now);
    expect(stats).toMatchObject({ students: 1, queue: { queued: 2, running: 1 }, aiHour: { calls: 5, failed: 3 } });
    expect(stats.aiHour.byProvider).toEqual({ 'bailian-token-plan': { calls: 4, failed: 3 }, bailian: { calls: 1, failed: 0 } });
    status = 502; body = 'bad gateway';
    const sent: Any[] = [];
    const sender = async (target: string, payload: Any) => { sent.push([target, payload]); };
    const first = await check({ ...cfg, barkKey: 'fake-bark-key', wecom: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fake' }, { now, sender, statsProvider: () => stats });
    expect(first.fresh.map((a: Any) => a.id).sort()).toEqual(['ai-fail', 'backup', 'http', 'queue']);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual(['https://api.day.app/push', expect.objectContaining({ device_key: 'fake-bark-key', title: '错题本告警（4 项）' })]);
    expect(sent[1][1]).toMatchObject({ msgtype: 'text' });
    expect(sent[1][1].text.content).toContain('学生登录页打不开');
    expect(sent[1][1].text.content).not.toMatch(/合成错题|0000aaaa/);

    sent.length = 0;
    const second = await check({ ...cfg, barkKey: 'fake-bark-key' }, { now: new Date(now.getTime() + 5 * 60_000), sender, statsProvider: () => stats });
    expect(second.alerts).toHaveLength(4);
    expect(second.fresh).toHaveLength(0);
    expect(sent).toHaveLength(0);

    status = 200; body = '邀请码';
    const third = await check({ ...cfg, barkKey: 'fake-bark-key' }, { now: new Date(now.getTime() + 10 * 60_000), sender, statsProvider: () => stats });
    expect(third.recovered).toEqual(['http']);
    expect(sent[0][1].body).toContain('已恢复：http');
  });

  it('when every push target fails, does not mark alerts as sent (retries next run, no false "recovered")', async () => {
    const { check, config } = await load('sel-healthcheck.mjs');
    const now = new Date('2026-10-22T12:00:00.000Z');
    studentDb().close();
    status = 502;
    const cfg = { ...config(), barkKey: 'fake-bark-key' };
    const stats = { students: 0, registeredToday: 0, queue: { queued: 0, running: 0, failedToday: 0 }, legacyJobs: 0, aiHour: { calls: 0, failed: 0, byProvider: {} }, aiToday: { calls: 0, failed: 0, durationSum: 0, timed: 0, byProvider: {} }, fallbackToday: null, unreadable: 0 };
    let attempts = 0;
    const failing = async () => { attempts += 1; throw new Error('push down'); };
    const first = await check(cfg, { now, sender: failing, statsProvider: () => stats });
    expect(first.delivered).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'state/health-state.json'), 'utf8')).sent).toEqual({});
    const second = await check(cfg, { now: new Date(now.getTime() + 5 * 60_000), sender: failing, statsProvider: () => stats });
    expect(second.fresh.map((a: Any) => a.id)).toContain('http');
    expect(attempts).toBe(2);
    status = 200; body = '邀请码';
    const sent: Any[] = [];
    const third = await check(cfg, { now: new Date(now.getTime() + 10 * 60_000), sender: async (_t: string, payload: Any) => { sent.push(payload); }, statsProvider: () => stats });
    expect(third.recovered).toEqual([]);
    expect(sent.every(p => !String(p.body).includes('已恢复'))).toBe(true);
  });

  it('counts paid fallbacks and blocked fallbacks separately (exact event names)', async () => {
    const { runChecks, config, countEvents } = await load('sel-healthcheck.mjs');
    const app = [
      '[worker 0000aaaa] {"event":"sel_ai_fallback","level":"warn"}',
      '[worker 0000aaaa] {"event":"sel_ai_fallback_blocked","level":"error"}',
      '[worker 0000bbbb] {"event":"sel_ai_fallback_blocked","level":"error"}',
      '{"event":"sel_ai_fallback","level":"warn"}',
      '[worker 0000aaaa] not json sel_ai_fallback',
      '{"event":"sel_worker_error","level":"error"}',
    ].join('\n');
    expect(countEvents(app, 'sel_ai_fallback')).toBe(2);
    expect(countEvents(app, 'sel_ai_fallback_blocked')).toBe(2);
    const cfg = { ...config(), skip: new Set(['systemd', 'http', 'cert']) };
    const { facts, alerts } = await runChecks(cfg, { statsProvider: () => ({ queue: { queued: 0, running: 0 }, legacyJobs: 0, aiHour: { calls: 0, failed: 0 }, unreadable: 0 }),
      journalReader: (args: string[]) => args.includes('super-error-log') ? app : '' });
    expect(facts).toMatchObject({ fallbacks1h: 2, fallbackBlocked1h: 2, workerErrors5m: 1 });
    expect(alerts.map((a: Any) => a.id)).toEqual(expect.arrayContaining(['fallback-blocked', 'worker']));
    expect(alerts.map((a: Any) => a.id)).not.toContain('fallback');
  });

  it('cert check resolves null when the peer accepts but never completes the TLS handshake', async () => {
    const { certDaysLeft } = await load('sel-healthcheck.mjs');
    const sockets: net.Socket[] = [];
    const silent = net.createServer(socket => { sockets.push(socket); });
    await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve));
    try {
      const started = Date.now();
      const days = await certDaysLeft({ connectHost: '127.0.0.1', tlsPort: (silent.address() as net.AddressInfo).port, publicHost: 'synthetic.invalid' }, Date.now(), 300);
      expect(days).toBeNull();
      expect(Date.now() - started).toBeLessThan(5000);
    } finally { for (const s of sockets) s.destroy(); await new Promise<void>(resolve => silent.close(() => resolve())); }
  });

  it('dry-run prints instead of sending and keeps no state; report summarizes the day', async () => {
    const { check, report, config, collectStats } = await load('sel-healthcheck.mjs');
    const now = new Date();
    studentDb().close();
    aiUsage([['bailian-token-plan', 'succeeded'], ['bailian', 'succeeded']], now);
    const cfg = config();
    const stats = collectStats(cfg.hostDir, now);
    const sender = async () => { throw new Error('must not send'); };
    await check({ ...cfg, barkKey: 'fake' }, { now, dryRun: true, sender, statsProvider: () => stats });
    expect(fs.existsSync(path.join(root, 'state/health-state.json'))).toBe(false);
    const daily = await report({ ...cfg, barkKey: 'fake' }, { now, dryRun: true, sender, statsProvider: () => stats });
    expect(daily.lines.join('\n')).toMatch(/AI 调用 2 次，失败 0/);
    expect(daily.lines.join('\n')).toContain('bailian-token-plan 1 次');
  });
});

describe('install script and syntax', () => {
  it('installs into a prefix with --dry-run printing only, and without touching existing config', () => {
    const prefix = path.join(root, 'prefix');
    const dry = spawnSync('bash', [path.join(OPS, 'install.sh'), '--dry-run'], { env: { ...process.env, SEL_OPS_PREFIX: prefix }, encoding: 'utf8' });
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('[dry-run] install');
    expect(fs.existsSync(prefix)).toBe(false);
    fs.mkdirSync(path.join(prefix, 'etc/super-error-log'), { recursive: true });
    fs.writeFileSync(path.join(prefix, 'etc/super-error-log/ops.env'), 'SEL_BACKUP_REMOTE=oss://kept/value\n');
    const real = spawnSync('bash', [path.join(OPS, 'install.sh')], { env: { ...process.env, SEL_OPS_PREFIX: prefix }, encoding: 'utf8' });
    expect(real.status, real.stderr).toBe(0);
    expect(fs.readFileSync(path.join(prefix, 'etc/super-error-log/ops.env'), 'utf8')).toContain('oss://kept/value');
    expect(fs.statSync(path.join(prefix, 'etc/super-error-log/alert.env')).mode & 0o777).toBe(0o600);
    for (const unit of ['sel-backup.timer', 'sel-healthcheck.timer', 'sel-daily-report.timer']) expect(fs.existsSync(path.join(prefix, 'etc/systemd/system', unit))).toBe(true);
    expect(fs.existsSync(path.join(prefix, 'usr/local/lib/sel-ops/sel-backup.mjs'))).toBe(true);
  });

  it('every shell script parses and every unit references the installed copies', () => {
    expect(spawnSync('bash', ['-n', path.join(OPS, 'install.sh')]).status).toBe(0);
    for (const unit of fs.readdirSync(path.join(OPS, 'systemd')).filter(name => name.endsWith('.service'))) {
      const text = fs.readFileSync(path.join(OPS, 'systemd', unit), 'utf8');
      expect(text).toMatch(/ExecStart=\/opt\/super-error-log\/node-v24\/bin\/node \/usr\/local\/lib\/sel-ops\//);
      expect(text).not.toContain('/opt/super-error-log/current/deploy');
    }
  });
});

function walkAll(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const p = path.join(dir, entry.name);
    return entry.isDirectory() ? walkAll(p, base) : [path.relative(base, p)];
  });
}
