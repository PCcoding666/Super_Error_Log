#!/usr/bin/env node
// 每 5 分钟一次的主机巡检 + 每晚日报，推送到 Bark 或企业微信群机器人。
//
//   sel-healthcheck.mjs check  [--dry-run]   巡检：有问题才推送；同一问题 60 分钟内不重复；恢复时推一条“已恢复”
//   sel-healthcheck.mjs report [--dry-run]   日报：今天的注册、AI 调用/失败/耗时、备用通道、队列、磁盘、备份
//   sel-healthcheck.mjs stats --dir <学生网关目录>   只读统计（JSON），由 check/report 以应用用户身份调用
//
// 以 root 运行（要读 journald、systemctl）。打开学生 SQLite 一律降到应用用户（runuser），避免留下 root 属主的 -wal/-shm。
// 推送 key 只从环境变量读：SEL_ALERT_BARK_KEY（可选 SEL_ALERT_BARK_SERVER）或 SEL_ALERT_WECOM_WEBHOOK。
// --dry-run：照常检查，但把要推送的内容打印出来，不发送、不更新去重状态。
// 测试/本机：SEL_OPS_SKIP=systemd,journal,cert,http 跳过对应检查；SEL_OPS_HEALTH_URL 指向本机测试服务。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, env, hasTable, hostDirOf, intEnv, isMain, log, openReadOnly, parseArgs, readJson, shanghaiDay, writeJsonAtomic } from './lib.mjs';

export function config() {
  const dataDir = path.resolve(env('SEL_OPS_DATA_DIR', DEFAULTS.dataDir));
  return {
    dataDir, hostDir: path.resolve(hostDirOf(dataDir)),
    backupDir: path.resolve(env('SEL_BACKUP_DIR', DEFAULTS.backupDir)),
    stateDir: path.resolve(env('SEL_OPS_STATE_DIR', DEFAULTS.stateDir)),
    appUser: env('SEL_OPS_APP_USER', DEFAULTS.appUser),
    node: env('SEL_OPS_NODE', DEFAULTS.node),
    publicHost: env('SEL_OPS_PUBLIC_HOST', DEFAULTS.publicHost),
    connectHost: env('SEL_OPS_CONNECT_HOST', DEFAULTS.connectHost),
    tlsPort: intEnv('SEL_OPS_TLS_PORT', 443),
    healthUrl: env('SEL_OPS_HEALTH_URL', ''),
    services: env('SEL_OPS_SERVICES', 'super-error-log super-error-log-caddy').split(/\s+/).filter(Boolean),
    skip: new Set(env('SEL_OPS_SKIP', '').split(',').map(item => item.trim()).filter(Boolean)),
    barkKey: env('SEL_ALERT_BARK_KEY', ''), barkServer: env('SEL_ALERT_BARK_SERVER', 'https://api.day.app'),
    wecom: env('SEL_ALERT_WECOM_WEBHOOK', ''),
    t: {
      diskMinGiB: intEnv('SEL_ALERT_DISK_MIN_GIB', 4), diskMaxPct: intEnv('SEL_ALERT_DISK_MAX_PCT', 85),
      queueMax: intEnv('SEL_ALERT_QUEUE_MAX', 30), aiFailPct: intEnv('SEL_ALERT_AI_FAIL_PCT', 20), aiMinCalls: intEnv('SEL_ALERT_AI_MIN_CALLS', 5),
      fallbackPerHour: intEnv('SEL_ALERT_FALLBACK_PER_HOUR', 10), certDays: intEnv('SEL_ALERT_CERT_DAYS', 20),
      backupMaxAgeH: intEnv('SEL_ALERT_BACKUP_MAX_AGE_H', 26), upstreamErrors: intEnv('SEL_ALERT_UPSTREAM_ERRORS', 0),
      repeatMin: intEnv('SEL_ALERT_REPEAT_MIN', 60),
      rejectedStudents: intEnv('SEL_ALERT_REJECTED_STUDENTS', 1), aiWaiting: intEnv('SEL_ALERT_AI_WAITING', 10),
      liveStaleMin: intEnv('SEL_ALERT_LIVE_STALE_MIN', 3),
    },
  };
}

// ---------- 只读统计（应用用户身份运行） ----------

function listDatabases(root) {
  const out = [];
  const visit = dir => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(p);
      else if (entry.isFile() && /\.db$/.test(entry.name)) out.push(p);
    }
  };
  visit(root);
  return out;
}

/** 汇总所有学生的队列与 AI 调用（不读题目内容、不读姓名手机号）。 */
export function collectStats(hostDir, now = new Date()) {
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  const day = shanghaiDay(now);
  const dayStart = new Date(`${day}T00:00:00+08:00`).toISOString();
  const stats = { students: 0, registeredToday: 0, queue: { queued: 0, running: 0, failedToday: 0 }, legacyJobs: 0,
    aiHour: { calls: 0, failed: 0, byProvider: {} }, aiToday: { calls: 0, failed: 0, durationSum: 0, timed: 0, byProvider: {} },
    fallbackToday: null, unreadable: 0,
    // 网关每 15 秒写一次的实时人数与 AI 并发（src/studentHost/liveStats.ts）；没开学生网关时没有。
    live: readJson(path.join(hostDir, 'live-status.json')) };
  const bump = (bucket, provider, failed, duration) => {
    bucket.calls += 1; if (failed) bucket.failed += 1;
    const p = bucket.byProvider[provider] ??= { calls: 0, failed: 0 };
    p.calls += 1; if (failed) p.failed += 1;
    if (duration !== null && bucket.durationSum !== undefined) { bucket.durationSum += duration; bucket.timed += 1; }
  };
  for (const file of listDatabases(hostDir)) {
    let db;
    try {
      db = openReadOnly(file);
      const name = path.basename(file);
      if (name === 'registry.db' && hasTable(db, 'students')) {
        stats.students = db.prepare('SELECT COUNT(*) AS n FROM students').get().n;
        stats.registeredToday = db.prepare('SELECT COUNT(*) AS n FROM students WHERE created_at >= ?').get(dayStart).n;
      }
      if (name === 'ai-fallback-ledger.db' && hasTable(db, 'ai_fallback')) {
        stats.fallbackToday = db.prepare(`SELECT COALESCE(SUM(CASE WHEN status <> 'blocked' THEN 1 ELSE 0 END), 0) AS calls,
          COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked,
          COALESCE(SUM(CASE WHEN status <> 'blocked' THEN COALESCE(tokens, 0) ELSE 0 END), 0) AS tokens FROM ai_fallback WHERE day = ?`).get(day);
      }
      if (hasTable(db, 'material_job')) {
        for (const row of db.prepare("SELECT state, COUNT(*) AS n FROM material_job WHERE state IN ('queued','running') GROUP BY state").all()) stats.queue[row.state] += row.n;
        stats.queue.failedToday += db.prepare("SELECT COUNT(*) AS n FROM material_job WHERE state = 'failed' AND updated_at >= ?").get(dayStart.replace('T', ' ').slice(0, 19)).n;
      }
      if (hasTable(db, 'ai_usage')) {
        for (const row of db.prepare('SELECT provider, status, duration_ms AS d, started_at AS t FROM ai_usage WHERE started_at >= ?').all(hourAgo < dayStart ? hourAgo : dayStart)) {
          const failed = row.status === 'failed';
          if (row.t >= hourAgo) bump(stats.aiHour, row.provider, failed, null);
          if (row.t >= dayStart) bump(stats.aiToday, row.provider, failed, row.d ?? null);
        }
      }
    } catch { stats.unreadable += 1; } finally { db?.close(); }
  }
  // 旧识别任务（job.json）还在排队的数量。
  const visit = dir => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(p);
      else if (entry.isFile() && entry.name === 'job.json') {
        try { if (['queued', 'processing'].includes(JSON.parse(fs.readFileSync(p, 'utf8')).status)) stats.legacyJobs += 1; } catch { stats.unreadable += 1; }
      }
    }
  };
  visit(hostDir);
  return stats;
}

function statsAsAppUser(cfg) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return collectStats(cfg.hostDir);
  const self = fileURLToPath(import.meta.url);
  const result = spawnSync('/usr/sbin/runuser', ['-u', cfg.appUser, '--', cfg.node, self, 'stats', '--dir', cfg.hostDir], { encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0) throw new Error('以应用用户读取统计失败');
  return JSON.parse(result.stdout);
}

// ---------- 主机检查 ----------

function sh(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 });
  return { status: result.status, stdout: result.stdout ?? '' };
}

function journal(args) { return sh('/usr/bin/journalctl', ['--no-pager', '-o', 'cat', ...args]).stdout; }

function count(text, pattern) { return text.split('\n').filter(line => pattern.test(line)).length; }

function fetchPage(cfg) {
  return new Promise(resolve => {
    const done = (ok, detail) => resolve({ ok, detail });
    let request;
    if (cfg.healthUrl) {
      const url = new URL(cfg.healthUrl);
      request = (url.protocol === 'https:' ? https : http).get(url, { timeout: 10_000 }, collect);
    } else {
      request = https.get({ host: cfg.connectHost, port: 443, path: '/s/', servername: cfg.publicHost, headers: { host: cfg.publicHost }, timeout: 10_000 }, collect);
    }
    function collect(response) {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { if (body.length < 200_000) body += chunk; });
      response.on('end', () => done(response.statusCode === 200 && body.includes('邀请码'), `HTTP ${response.statusCode}`));
    }
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', error => done(false, error.message.slice(0, 80)));
  });
}

/** 证书剩余天数；读不到（连不上、握手超时、没有证书）返回 null。一定会在 timeoutMs 内结束。 */
export function certDaysLeft(cfg, now = Date.now(), timeoutMs = 10_000) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(value); };
    const socket = tls.connect({ host: cfg.connectHost, port: cfg.tlsPort ?? 443, servername: cfg.publicHost, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate();
      const end = Date.parse(cert?.valid_to ?? '');
      finish(Number.isFinite(end) ? Math.floor((end - now) / 86_400_000) : null);
    });
    // 对方接受连接但一直不握手时，socket 的 timeout 事件不会自己结束 Promise：用独立计时器兜底。
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
  });
}

/** 数 journald 里某个事件的行数：按 JSON 的 event 字段精确匹配（worker 行带 "[worker xxxxxxxx] " 前缀）。 */
export function countEvents(text, name) {
  let n = 0;
  for (const line of text.split('\n')) {
    const start = line.indexOf('{');
    if (start < 0) continue;
    try { if (JSON.parse(line.slice(start)).event === name) n += 1; } catch { /* 不是 JSON 行 */ }
  }
  return n;
}

function disk(dir) {
  const s = fs.statfsSync(dir);
  const free = s.bavail * s.bsize; const total = s.blocks * s.bsize;
  return { freeGiB: free / 1024 ** 3, usedPct: total ? (1 - s.bavail / s.blocks) * 100 : 0 };
}

const pct = (part, whole) => whole ? Math.round((part / whole) * 100) : 0;

/** 运行全部检查，返回 { alerts: [{id,text}], facts }。每项检查自己 try/catch，一项坏了不影响其他项。 */
export async function runChecks(cfg, { now = new Date(), statsProvider = statsAsAppUser, state = {}, journalReader = journal } = {}) {
  const alerts = []; const facts = {};
  const add = (id, text) => alerts.push({ id, text });
  const guard = async (name, fn) => { try { await fn(); } catch (error) { add(`check-${name}`, `检查「${name}」本身出错：${error instanceof Error ? error.message.slice(0, 120) : error}`); } };

  if (!cfg.skip.has('systemd')) await guard('服务', () => {
    const restarts = {};
    for (const service of cfg.services) {
      if (sh('/usr/bin/systemctl', ['is-active', '--quiet', service]).status !== 0) add(`down-${service}`, `${service} 没有在运行`);
      const n = Number(sh('/usr/bin/systemctl', ['show', '-p', 'NRestarts', '--value', service]).stdout.trim());
      if (Number.isFinite(n)) {
        restarts[service] = n;
        const before = state.restarts?.[service];
        if (typeof before === 'number' && n > before) add(`restart-${service}`, `${service} 刚刚自动重启了 ${n - before} 次（可能崩溃）`);
      }
    }
    facts.restarts = restarts;
  });

  if (!cfg.skip.has('http')) await guard('网站', async () => {
    const page = await fetchPage(cfg);
    facts.http = page.detail;
    if (!page.ok) add('http', `学生登录页打不开或内容不对（${page.detail}）`);
  });

  if (!cfg.skip.has('journal')) await guard('日志', () => {
    const caddy = journalReader(['-u', 'super-error-log-caddy', '--since', '-5min']);
    const upstream = count(caddy, /"level":"error"/);
    facts.upstreamErrors5m = upstream;
    if (upstream > cfg.t.upstreamErrors) add('upstream', `最近 5 分钟 Caddy 记录了 ${upstream} 条上游错误（学生可能看到 502/5xx）`);
    const kernel = journalReader(['-k', '--since', '-5min']);
    if (count(kernel, /killed process|out of memory/i) > 0) add('oom', '最近 5 分钟内核因为内存不足杀了进程（OOM）');
    const app5 = journalReader(['-u', 'super-error-log', '--since', '-5min']);
    const workerErrors = countEvents(app5, 'sel_worker_error');
    facts.workerErrors5m = workerErrors;
    if (workerErrors > 0) add('worker', `最近 5 分钟有 ${workerErrors} 条学生进程错误（journalctl -u super-error-log | grep sel_worker_error）`);
    const app60 = journalReader(['-u', 'super-error-log', '--since', '-60min']);
    const fallbacks = countEvents(app60, 'sel_ai_fallback');
    const blocked = countEvents(app60, 'sel_ai_fallback_blocked');
    facts.fallbacks1h = fallbacks; facts.fallbackBlocked1h = blocked;
    if (fallbacks > cfg.t.fallbackPerHour) add('fallback', `最近 1 小时 Token Plan 失败后改走按量付费 ${fallbacks} 次（在花按量的钱）`);
    if (blocked > 0) add('fallback-blocked', `按量付费备用通道今天已到上限，最近 1 小时拒绝了 ${blocked} 次；Token Plan 恢复前识别会失败`);
  });

  await guard('磁盘', () => {
    for (const dir of [...new Set(['/', cfg.dataDir].filter(d => fs.existsSync(d)))]) {
      const d = disk(dir);
      facts[`disk:${dir}`] = `${d.freeGiB.toFixed(1)} GiB 空闲 / 已用 ${d.usedPct.toFixed(0)}%`;
      if (d.freeGiB < cfg.t.diskMinGiB || d.usedPct > cfg.t.diskMaxPct) add(`disk-${dir}`, `${dir} 只剩 ${d.freeGiB.toFixed(1)} GiB（已用 ${d.usedPct.toFixed(0)}%）；低于 3 GiB 会拒收上传、低于 2 GiB 不能发布`);
    }
  });

  await guard('队列与 AI', () => {
    const stats = statsProvider(cfg);
    facts.stats = stats;
    const waiting = stats.queue.queued + stats.queue.running + stats.legacyJobs;
    if (waiting > cfg.t.queueMax) add('queue', `待处理的识别任务积压 ${waiting} 个（排队 ${stats.queue.queued}、处理中 ${stats.queue.running}、旧识别 ${stats.legacyJobs}）`);
    const { calls, failed } = stats.aiHour;
    if (calls >= cfg.t.aiMinCalls && pct(failed, calls) > cfg.t.aiFailPct) add('ai-fail', `最近 1 小时 AI 调用失败率 ${pct(failed, calls)}%（${failed}/${calls}）`);
    if (stats.unreadable > 0) add('stats-unreadable', `有 ${stats.unreadable} 个数据库读不了（统计不完整）`);
    const live = stats.live;
    if (live?.at) {
      facts.live = liveLine(live);
      const ageMin = (now.getTime() - Date.parse(live.at)) / 60_000;
      if (!(ageMin <= cfg.t.liveStaleMin)) add('live-stale', `实时人数已经 ${Math.round(ageMin)} 分钟没有更新（服务可能卡住或没在运行）`);
      else {
        const m = live.last5m ?? {};
        if (cfg.t.rejectedStudents > 0 && (m.rejectedStudents ?? 0) >= cfg.t.rejectedStudents) add('capacity', `最近 5 分钟有 ${m.rejectedStudents} 位同学因为错题本名额满（${live.live}/${live.maxLive}）进不去，被挡 ${m.capacityRejections} 次`);
        if (cfg.t.aiWaiting > 0 && (m.peakAiWaiting ?? 0) >= cfg.t.aiWaiting) add('ai-waiting', `最近 5 分钟 AI 排队最多 ${m.peakAiWaiting} 件（同时最多做 ${live.aiLimit} 件）`);
      }
    }
  });

  if (!cfg.skip.has('cert')) await guard('证书', async () => {
    const days = await certDaysLeft(cfg, now.getTime());
    facts.certDaysLeft = days;
    if (days === null) add('cert', '读不到 HTTPS 证书');
    else if (days < cfg.t.certDays) add('cert', `HTTPS 证书还有 ${days} 天过期（自动续期可能失败，查 journalctl -u super-error-log-caddy）`);
  });

  if (!cfg.skip.has('backup')) await guard('备份', () => {
    const last = readJson(path.join(cfg.backupDir, 'last-status.json'));
    const ageH = last?.finishedAt ? (now.getTime() - Date.parse(last.finishedAt)) / 3_600_000 : Infinity;
    facts.backup = last ? `${last.day} ${last.ok ? '成功' : '失败'}` : '没有记录';
    if (!last?.ok || ageH > cfg.t.backupMaxAgeH) add('backup', last ? `每日备份${last.ok ? `已经 ${Math.round(ageH)} 小时没有更新` : '上次失败'}（${last.day}）` : '还没有任何每日备份记录');
    const pushed = readJson(path.join(cfg.backupDir, 'last-push.json'));
    facts.offsite = pushed ? `${pushed.day} ${pushed.ok ? '已推送' : pushed.reason}` : '没有记录';
    if (pushed?.reason === 'not_configured') add('offsite', '异地备份没有配置（SEL_BACKUP_REMOTE=none），磁盘坏了数据就没了');
    else if (!pushed?.ok && last?.ok) add('offsite', `异地备份没有成功（${pushed?.reason ?? '没有记录'}）`);
  });
  return { alerts, facts };
}

// ---------- 实时人数 ----------

export function liveLine(live) {
  const avg = live.aiAverageMs ? `，平均 ${(live.aiAverageMs / 1000).toFixed(0)} s` : '';
  return `在用 ${live.activeStudents} 人，错题本 ${live.live}/${live.maxLive}，AI 在做 ${live.aiInUse}/${live.aiLimit}、排队 ${live.aiWaiting}${avg}${live.waitingOutside ? `，门外等 ${live.waitingOutside} 人` : ''}`;
}

export function todayLine(live) {
  const t = live.today;
  return `今天高峰：在用 ${t.peakActive} 人，错题本 ${t.peakLive}/${live.maxLive}，AI 同时 ${t.peakAiInUse}/${live.aiLimit}、排队最多 ${t.peakAiWaiting}；名额满被挡 ${t.rejectedStudents} 人（${t.capacityRejections} 次）`;
}

// ---------- 推送 ----------

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const request = https.request(url, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length }, timeout: 15_000 }, response => {
      response.resume();
      response.on('end', () => (response.statusCode && response.statusCode < 300 ? resolve() : reject(new Error(`HTTP ${response.statusCode}`))));
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end(data);
  });
}

export async function notify(cfg, title, body, { dryRun = false, sender = postJson } = {}) {
  if (dryRun || (!cfg.barkKey && !cfg.wecom)) {
    log(dryRun ? 'notify_dry_run' : 'notify_not_configured', { title, body });
    return dryRun;
  }
  const sends = [];
  if (cfg.barkKey) sends.push(sender(`${cfg.barkServer.replace(/\/$/, '')}/push`, { device_key: cfg.barkKey, title, body, group: 'super-error-log' }));
  if (cfg.wecom) sends.push(sender(cfg.wecom, { msgtype: 'text', text: { content: `${title}\n${body}` } }));
  const results = await Promise.allSettled(sends);
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length) log('notify_failed', { failures: failed.length });
  return failed.length < results.length;
}

/** 去重：同一问题 repeatMin 内不重复推；上次推过、这次没了的，推一条“已恢复”。 */
export function decide(alerts, state, now, repeatMin) {
  const sent = { ...(state.sent ?? {}) };
  const fresh = []; const recovered = [];
  const active = new Set(alerts.map(a => a.id));
  for (const alert of alerts) {
    const last = sent[alert.id];
    if (!last || now - last >= repeatMin * 60_000) { fresh.push(alert); sent[alert.id] = now; }
  }
  for (const id of Object.keys(sent)) if (!active.has(id)) { recovered.push(id); delete sent[id]; }
  return { fresh, recovered, sent };
}

export async function check(cfg = config(), { dryRun = false, now = new Date(), statsProvider, sender } = {}) {
  const stateFile = path.join(cfg.stateDir, 'health-state.json');
  const state = readJson(stateFile) ?? {};
  const { alerts, facts } = await runChecks(cfg, { now, statsProvider, state });
  const decided = decide(alerts, state, now.getTime(), cfg.t.repeatMin);
  const { fresh, recovered } = decided;
  let sent = decided.sent;
  let delivered = true;
  if (fresh.length || recovered.length) {
    const lines = [...fresh.map(a => `• ${a.text}`), ...(recovered.length ? [`已恢复：${recovered.join('、')}`] : []), ...(facts.live ? [`现在：${facts.live}`] : [])];
    const title = fresh.length ? `错题本告警（${fresh.length} 项）` : '错题本已恢复';
    delivered = await notify(cfg, title, lines.join('\n'), { dryRun, sender });
    // 一个目标都没送到：不记成“已推送”，下次巡检重试；从没送到的告警以后也不会冒出“已恢复”。
    if (!delivered) sent = state.sent ?? {};
  }
  if (!dryRun) {
    fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(stateFile, { sent, restarts: facts.restarts ?? state.restarts ?? {}, checkedAt: now.toISOString() });
  }
  log('health_check', { alerts: alerts.map(a => a.id), pushed: delivered ? fresh.map(a => a.id) : [], recovered: delivered ? recovered : [], delivered });
  return { alerts, fresh, recovered, facts, delivered };
}

export async function report(cfg = config(), { dryRun = false, now = new Date(), statsProvider = statsAsAppUser, sender } = {}) {
  const stats = statsProvider(cfg);
  const { alerts, facts } = await runChecks({ ...cfg, skip: new Set([...cfg.skip, 'systemd']) }, { now, statsProvider: () => stats });
  const avg = stats.aiToday.timed ? (stats.aiToday.durationSum / stats.aiToday.timed / 1000).toFixed(1) : '—';
  const providers = Object.entries(stats.aiToday.byProvider).map(([name, p]) => `${name} ${p.calls} 次/失败 ${p.failed}`).join('；') || '无';
  const lines = [
    `账号 ${stats.students}（今天新增 ${stats.registeredToday}）`,
    `AI 调用 ${stats.aiToday.calls} 次，失败 ${stats.aiToday.failed}（${pct(stats.aiToday.failed, stats.aiToday.calls)}%），平均 ${avg} s`,
    `分线路：${providers}`,
    `按量付费备用：${stats.fallbackToday ? `${stats.fallbackToday.calls} 次，被上限拒绝 ${stats.fallbackToday.blocked} 次` : '今天没有'}`,
    `队列：排队 ${stats.queue.queued}、处理中 ${stats.queue.running}；今天失败 ${stats.queue.failedToday}`,
    ...(stats.live?.today ? [todayLine(stats.live)] : []),
    ...Object.entries(facts).filter(([key]) => key.startsWith('disk:')).map(([key, value]) => `磁盘 ${key.slice(5)}：${value}`),
    ...(cfg.skip.has('backup') ? [] : [`每日备份：${facts.backup ?? '—'}；异地：${facts.offsite ?? '—'}`]),
    alerts.length ? `当前问题：${alerts.map(a => a.text).join('；')}` : '当前没有告警',
  ];
  await notify(cfg, `错题本日报 ${shanghaiDay(now)}`, lines.join('\n'), { dryRun, sender });
  return { lines };
}

if (isMain(import.meta.url)) {
  const { flags, values, positional } = parseArgs(process.argv.slice(2));
  const dryRun = flags.has('dry-run');
  try {
    if (positional[0] === 'stats') process.stdout.write(`${JSON.stringify(collectStats(path.resolve(values.dir ?? config().hostDir)))}\n`);
    else if (positional[0] === 'check') await check(config(), { dryRun });
    else if (positional[0] === 'report') await report(config(), { dryRun });
    else { process.stderr.write('用法：sel-healthcheck.mjs check|report|stats [--dry-run]\n'); process.exitCode = 2; }
  } catch (error) {
    process.stderr.write(`巡检失败：${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
