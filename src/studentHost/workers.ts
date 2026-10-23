/**
 * 学生空间 worker 进程池（studentHost 网关的转发目标）。
 * - 每个学生最多一个 worker 进程：child_process.fork，独立 SEL_DATA_DIR / SEL_MOBILE_DATA_DIR（目录 0700）。
 * - 不在启动时为全部学生预热。第一次 ensure 才 fork；空闲 SEL_WORKER_IDLE_MS（缺省 12 分钟）后退出。
 * - 有正在转发的请求，或 worker 报告仍有识别/打印任务时，不退出。磁盘上的未完成任务下次启动续做。
 * - SEL_MAX_LIVE_WORKERS（缺省 8，0 不限制）超出时，先请最久未使用且空闲的 worker 退出；都在忙则拒绝本次启动。
 * - 父进程持有视觉调用和图片处理两把信号量，worker 经 IPC 排队，避免几十个学生同时打满模型和 sharp。
 * - 单个学生同时处理的照片和材料任务数由 SEL_STUDENT_AI_CONCURRENCY 决定（缺省 3，在 worker 内生效）。每次模型调用和 sharp 仍要再拿上面两把全局名额。
 * - worker 只监听 127.0.0.1 随机端口；端口与内部设备令牌经 IPC ready 回传，父进程据此注入 sel_device 转发。
 * - 启动并发去重（同一学生的并发 ensure 共享同一次启动），启动超时 20 秒。
 * - 崩溃只影响本学生：按 studentId 键控，下一次 ensure 重新拉起，绝不把请求路由到别人的 worker。
 * - 父进程退出 / IPC 断开时 worker 自行退出（worker 侧 process.on('disconnect')）；stopAll 先礼后兵。
 * - 内部设备令牌 30 天有效；长期运行靠定期 refresh-token IPC 换新（默认每 7 天，可注入缩短测试）。
 */
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiConcurrency, imageConcurrency, maxLiveWorkers, workerIdleMs } from './limits.js';
import { PermitPool } from './permits.js';

export const WORKER_START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;
const BUSY_RETRY_MS = 15_000;
const QUERY_TIMEOUT_MS = 2_000;
const TOKEN_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const STDERR_TAIL_LINES = 20;

export interface WorkerEndpoint { port: number; token: string }

export interface StudentWorkerPoolOptions {
  /** 学生 ID → 该学生的独立数据目录（registry.studentDir）。 */
  dirFor: (studentId: string) => string;
  startTimeoutMs?: number;
  /** 覆盖/追加给 worker 的环境变量（测试注入 SEL_STUDENT_WORKER_FAKE 等）。 */
  env?: NodeJS.ProcessEnv;
  /** 覆盖 worker 入口脚本与解析器（缺省：dist 下用编译产物，否则 tsx 跑源码）。 */
  workerScript?: string;
  execArgv?: string[];
  refreshIntervalMs?: number;
  /** 空闲多久退出。缺省读 SEL_WORKER_IDLE_MS。0 表示不因空闲退出。 */
  idleMs?: number;
  /** 同时存活的 worker 上限。缺省读 SEL_MAX_LIVE_WORKERS。0 表示不限制。 */
  maxLiveWorkers?: number;
  /** 跨学生视觉模型并发。缺省读 SEL_GLOBAL_AI_CONCURRENCY。 */
  aiConcurrency?: number;
  /** 跨学生图片处理并发。缺省读 SEL_GLOBAL_IMAGE_CONCURRENCY。 */
  imageConcurrency?: number;
  /** worker 报错/异常退出的回调（不写秘密）；缺省静默。 */
  onError?: (studentId: string, message: string) => void;
}

export class WorkerStartError extends Error {
  constructor(studentId: string, message: string, readonly reason: 'start' | 'capacity' = 'start') {
    super(`学生空间启动失败：${message}`);
    this.name = 'WorkerStartError';
  }
}

interface WorkerEntry {
  child: ChildProcess;
  endpoint: WorkerEndpoint;
  refreshTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  stderrTail: string[];
  lastUsedAt: number;
  expectedExit: boolean;
  /** 观察到后台任务后，要等它结束再重新计算空闲时间。 */
  deferIdle: boolean;
}

/** 父进程退出兜底：全进程只挂一次 exit 钩子（worker 侧另有 IPC 断开自退，双保险）。 */
const livePools = new Set<StudentWorkerPool>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const pool of livePools) pool.killAllSync();
  });
}

function defaultWorkerScript(): { script: string; execArgv: string[] } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (here.includes(`${path.sep}dist${path.sep}`)) return { script: path.join(here, 'worker.js'), execArgv: [] };
  // 开发/测试态：用 tsx 加载器跑 TS 源码（拼接写法：依赖守卫按静态 import 形态扫描 dist 文本，tsx 只是 devDependency，不能出现在其正则视野里）。
  return { script: path.join(here, 'worker.ts'), execArgv: [`--${'impor'}t`, 'tsx'] };
}

export interface CapacitySnapshot { live: number; maxLive: number; aiLimit: number; aiInUse: number; aiWaiting: number; aiAverageMs: number | null }

export class StudentWorkerPool {
  private readonly entries = new Map<string, WorkerEntry>();
  private readonly starting = new Map<string, Promise<WorkerEndpoint>>();
  private readonly inflight = new Map<string, number>();
  private readonly idleStops = new Map<string, Promise<boolean>>();
  private readonly aiPermits: PermitPool;
  private readonly imagePermits: PermitPool;
  private readonly startTimeoutMs: number;
  private readonly refreshIntervalMs: number;
  private readonly idleMs: number;
  private readonly maxLive: number;
  private slotsReserved = 0;
  private stopping = false;

  constructor(private readonly options: StudentWorkerPoolOptions) {
    this.startTimeoutMs = options.startTimeoutMs ?? WORKER_START_TIMEOUT_MS;
    this.refreshIntervalMs = options.refreshIntervalMs ?? TOKEN_REFRESH_INTERVAL_MS;
    this.idleMs = options.idleMs ?? workerIdleMs();
    this.maxLive = options.maxLiveWorkers ?? maxLiveWorkers();
    this.aiPermits = new PermitPool(options.aiConcurrency ?? aiConcurrency());
    this.imagePermits = new PermitPool(options.imageConcurrency ?? imageConcurrency());
    livePools.add(this);
    installExitHook();
  }

  /** 进程退出钩子里用：同步杀，不等待。 */
  killAllSync(): void {
    for (const entry of this.entries.values()) {
      try { entry.child.kill('SIGKILL'); } catch { /* 已经退出 */ }
    }
  }

  /** 当前存活 worker 数（测试与容量观察用）。 */
  get size(): number {
    return this.entries.size;
  }

  /** 「人有点多」页用：只有计数，不含任何学生身份。 */
  capacitySnapshot(): CapacitySnapshot {
    return { live: this.entries.size, maxLive: this.maxLive, aiLimit: this.aiPermits.limit, aiInUse: this.aiPermits.inUse, aiWaiting: this.aiPermits.waiting, aiAverageMs: this.aiPermits.averageHoldMs };
  }

  isRunning(studentId: string): boolean {
    const entry = this.entries.get(studentId);
    return !!entry && entry.child.exitCode === null && !entry.child.killed;
  }

  /** 网关开始转发前调用：这段时间不算空闲，也不会被腾位置。 */
  retain(studentId: string): void {
    this.inflight.set(studentId, (this.inflight.get(studentId) ?? 0) + 1);
    const entry = this.entries.get(studentId);
    if (!entry) return;
    entry.lastUsedAt = Date.now();
    entry.deferIdle = false;
    this.disarm(entry);
  }

  /** 与 retain 成对。请求结束且没有别的转发时，重新计算空闲时间。 */
  release(studentId: string): void {
    const next = (this.inflight.get(studentId) ?? 0) - 1;
    if (next <= 0) this.inflight.delete(studentId);
    else this.inflight.set(studentId, next);
    if (next <= 0) this.armIdle(studentId, this.idleMs);
  }

  /** 取该学生的 worker 端点；没起就拉起（并发去重）。正在空闲退出的进程不拿来转发。 */
  async ensure(studentId: string): Promise<WorkerEndpoint> {
    if (this.stopping) throw new WorkerStartError(studentId, '进程池正在关闭。');
    const exiting = this.entries.get(studentId);
    if (exiting?.expectedExit) await this.idleStops.get(studentId);
    if (this.isRunning(studentId)) {
      const entry = this.entries.get(studentId)!;
      if (!entry.expectedExit) {
        entry.lastUsedAt = Date.now();
        return { ...entry.endpoint };
      }
    }
    const pending = this.starting.get(studentId);
    if (pending) return pending;
    const start = this.start(studentId);
    this.starting.set(studentId, start);
    try { return await start; } finally { this.starting.delete(studentId); }
  }

  private async start(studentId: string): Promise<WorkerEndpoint> {
    const reserved = this.maxLive > 0;
    if (reserved) this.slotsReserved += 1;
    try {
      if (this.maxLive > 0) await this.evictUntilFit(studentId);
      return await this.fork(studentId);
    } finally {
      if (reserved) this.slotsReserved -= 1;
    }
  }

  private async evictUntilFit(studentId: string): Promise<void> {
    const skipped = new Set<string>();
    while (this.entries.size + this.slotsReserved > this.maxLive) {
      const victim = this.pickVictim(studentId, skipped);
      if (!victim) throw new WorkerStartError(studentId, '同时打开的学习空间已达上限。', 'capacity');
      const stopped = await this.idleStop(victim);
      if (!stopped) skipped.add(victim);
    }
  }

  private pickVictim(studentId: string, skipped: ReadonlySet<string>): string | null {
    let oldest: { id: string; at: number } | null = null;
    for (const [id, entry] of this.entries) {
      if (id === studentId || skipped.has(id) || entry.expectedExit) continue;
      if ((this.inflight.get(id) ?? 0) > 0) continue;
      if (!oldest || entry.lastUsedAt < oldest.at) oldest = { id, at: entry.lastUsedAt };
    }
    return oldest?.id ?? null;
  }

  private async fork(studentId: string): Promise<WorkerEndpoint> {
    const studentDir = this.options.dirFor(studentId);
    const resolved = this.options.workerScript
      ? { script: this.options.workerScript, execArgv: this.options.execArgv ?? [] }
      : defaultWorkerScript();
    const child = fork(resolved.script, [], {
      execArgv: resolved.execArgv,
      env: {
        ...process.env,
        SEL_STUDENT_DATA_DIR: studentDir,
        SEL_DATA_DIR: studentDir,
        SEL_MOBILE_DATA_DIR: studentDir,
        SEL_STUDENT_HOST_ENABLED: '0',
        SEL_STUDENT_WORKER: '1',
        ...this.options.env,
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    // 子进程 stderr 只进内部回调（可能带路径等私密信息），绝不拼进可观察异常/响应。
    const stderrTail: string[] = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        stderrTail.push(line.slice(0, 300));
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      }
    });
    // 必须接 error 事件：spawn 失败/通道错误没人接会把整个主进程打挂。
    child.on('error', error => {
      this.options.onError?.(studentId, `worker 进程错误：${error.message}`);
    });

    const endpoint = await new Promise<WorkerEndpoint>((resolve, reject) => {
      const fail = (reason: string, kill: boolean): void => {
        cleanup();
        if (kill) child.kill('SIGKILL');
        reject(new WorkerStartError(studentId, reason));
      };
      const timer = setTimeout(() => fail(`启动超时（${this.startTimeoutMs} ms）`, true), this.startTimeoutMs);
      const onMessage = (message: unknown): void => {
        if (!message || typeof message !== 'object') return;
        const type = (message as { type?: unknown }).type;
        if (type === 'ready') {
          const { port, token } = message as { port?: unknown; token?: unknown };
          if (typeof port === 'number' && Number.isInteger(port) && port > 0 && typeof token === 'string' && token.length > 0) {
            cleanup();
            resolve({ port, token });
          }
          return;
        }
        if (type === 'error') {
          // worker 主动报的启动错误（消息由 worker 自己生成，不含秘密）。
          fail(String((message as { message?: unknown }).message ?? '启动失败'), true);
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (stderrTail.length > 0) this.options.onError?.(studentId, `worker 启动期 stderr：${stderrTail.join(' | ')}`);
        fail(`进程提前退出（code ${code ?? 'null'} ${signal ?? ''}）`, false);
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('exit', onExit);
      };
      child.on('message', onMessage);
      child.once('exit', onExit);
    });

    const entry: WorkerEntry = {
      child, endpoint, refreshTimer: null, idleTimer: null, stderrTail, lastUsedAt: Date.now(), expectedExit: false, deferIdle: false,
    };
    // 崩溃/退出：从表里摘除（下一次 ensure 重拉），通知观察者。不做自动重启，避免崩溃风暴。
    child.once('exit', (code, signal) => {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      if (entry.refreshTimer) clearInterval(entry.refreshTimer);
      if (this.entries.get(studentId) === entry) this.entries.delete(studentId);
      this.aiPermits.dropOwner(studentId);
      this.imagePermits.dropOwner(studentId);
      if (!this.stopping && !entry.expectedExit) this.options.onError?.(studentId, `worker 退出（code ${code ?? 'null'} ${signal ?? ''}）`);
    });
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const type = (message as { type?: unknown }).type;
      if (type === 'token' && typeof (message as { token?: unknown }).token === 'string') {
        entry.endpoint = { ...entry.endpoint, token: (message as { token: string }).token };
        return;
      }
      if (type !== 'acquire' && type !== 'release') return;
      const kind = (message as { kind?: unknown }).kind;
      const id = (message as { id?: unknown }).id;
      if ((kind !== 'ai' && kind !== 'image') || typeof id !== 'string' || !id) return;
      const pool = kind === 'ai' ? this.aiPermits : this.imagePermits;
      if (type === 'release') { pool.release(studentId, id); return; }
      pool.acquire(studentId, id, () => {
        if (!child.connected) { pool.release(studentId, id); return; }
        child.send({ type: 'permit', id }, error => { if (error) pool.release(studentId, id); });
      });
    });
    if (this.refreshIntervalMs > 0) {
      entry.refreshTimer = setInterval(() => {
        // send 回调吞掉「通道已关闭」竞态（worker 刚退出时 connected 可能还亮着）。
        if (child.connected) child.send({ type: 'refresh-token' }, () => undefined);
      }, this.refreshIntervalMs);
      entry.refreshTimer.unref();
    }
    this.entries.set(studentId, entry);
    if ((this.inflight.get(studentId) ?? 0) === 0) this.armIdle(studentId, this.idleMs);
    return { ...endpoint };
  }

  private disarm(entry: WorkerEntry): void {
    if (!entry.idleTimer) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  private armIdle(studentId: string, delay: number): void {
    const entry = this.entries.get(studentId);
    if (!entry || this.idleMs <= 0 || entry.expectedExit) return;
    this.disarm(entry);
    entry.idleTimer = setTimeout(() => { void this.onIdle(studentId); }, delay);
    entry.idleTimer.unref();
  }

  private async onIdle(studentId: string): Promise<void> {
    const entry = this.entries.get(studentId);
    if (!entry || this.stopping || entry.expectedExit) return;
    entry.idleTimer = null;
    if ((this.inflight.get(studentId) ?? 0) > 0) return;
    // 上一轮看到后台任务：先确认它已经结束，再空闲一整段时间，避免任务刚做完就被关掉。
    if (entry.deferIdle) {
      entry.deferIdle = false;
      const busy = await this.queryBusy(entry);
      if (this.entries.get(studentId) !== entry || entry.expectedExit) return;
      if ((this.inflight.get(studentId) ?? 0) > 0) return;
      if (busy) {
        entry.deferIdle = true;
        this.armIdle(studentId, Math.min(this.idleMs, BUSY_RETRY_MS));
        return;
      }
      this.armIdle(studentId, this.idleMs);
      return;
    }
    const stopped = await this.idleStop(studentId);
    if (stopped || !this.entries.has(studentId)) return;
    const current = this.entries.get(studentId);
    if (!current || current.expectedExit) return;
    current.deferIdle = true;
    this.armIdle(studentId, Math.min(this.idleMs, BUSY_RETRY_MS));
  }

  /** 仅在没有转发、worker 也报告没有后台任务时退出。忙则留下。 */
  private idleStop(studentId: string): Promise<boolean> {
    const existing = this.idleStops.get(studentId);
    if (existing) return existing;
    const run = this.idleStopNow(studentId).finally(() => { this.idleStops.delete(studentId); });
    this.idleStops.set(studentId, run);
    return run;
  }

  private async idleStopNow(studentId: string): Promise<boolean> {
    const entry = this.entries.get(studentId);
    if (!entry) return true;
    if ((this.inflight.get(studentId) ?? 0) > 0) return false;
    const busy = await this.queryBusy(entry);
    if (this.entries.get(studentId) !== entry) return true;
    if ((this.inflight.get(studentId) ?? 0) > 0 || busy) return false;
    entry.expectedExit = true;
    this.disarm(entry);
    const child = entry.child;
    if (child.exitCode !== null || child.killed) return true;
    const outcome = new Promise<boolean>(resolve => {
      const finish = (stopped: boolean): void => { cleanup(); resolve(stopped); };
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, STOP_TIMEOUT_MS);
      const onMessage = (message: unknown): void => {
        if ((message as { type?: unknown })?.type === 'stop-refused') finish(false);
      };
      const onExit = (): void => finish(true);
      const cleanup = (): void => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('exit', onExit);
      };
      child.on('message', onMessage);
      child.once('exit', onExit);
      if (child.connected) child.send({ type: 'stop', force: false }, () => undefined);
      else child.kill('SIGTERM');
    });
    const stopped = await outcome;
    if (!stopped && this.entries.get(studentId) === entry) entry.expectedExit = false;
    return stopped;
  }

  private queryBusy(entry: WorkerEntry): Promise<boolean> {
    const child = entry.child;
    if (!child.connected) return Promise.resolve(true);
    return new Promise(resolve => {
      const finish = (busy: boolean): void => { cleanup(); resolve(busy); };
      const timer = setTimeout(() => finish(true), QUERY_TIMEOUT_MS);
      const onMessage = (message: unknown): void => {
        if ((message as { type?: unknown })?.type !== 'busy') return;
        finish((message as { busy?: unknown }).busy === true);
      };
      const cleanup = (): void => { clearTimeout(timer); child.off('message', onMessage); };
      child.on('message', onMessage);
      child.send({ type: 'query-busy' }, error => { if (error) finish(true); });
    });
  }

  /** 立即换新该学生的内部令牌（测试令牌刷新路径）。 */
  async refreshToken(studentId: string): Promise<void> {
    const entry = this.entries.get(studentId);
    if (!entry || !entry.child.connected) throw new WorkerStartError(studentId, 'worker 不在运行。');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new WorkerStartError(studentId, '令牌刷新超时。')); }, this.startTimeoutMs);
      const onMessage = (message: unknown): void => {
        if ((message as { type?: unknown })?.type === 'token') { cleanup(); resolve(); }
      };
      const cleanup = (): void => { clearTimeout(timer); entry.child.off('message', onMessage); };
      entry.child.on('message', onMessage);
      entry.child.send({ type: 'refresh-token' }, () => undefined);
    });
  }

  async stop(studentId: string): Promise<void> {
    const entry = this.entries.get(studentId);
    if (!entry) return;
    entry.expectedExit = true;
    this.disarm(entry);
    this.entries.delete(studentId);
    if (entry.refreshTimer) clearInterval(entry.refreshTimer);
    const child = entry.child;
    if (child.exitCode !== null || child.killed) return;
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    if (child.connected) child.send({ type: 'stop', force: true }, () => undefined);
    else child.kill('SIGTERM');
    const timed = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), STOP_TIMEOUT_MS)),
    ]);
    if (!timed) {
      child.kill('SIGKILL');
      await exited;
    }
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.entries.keys()].map(studentId => this.stop(studentId)));
    // 正在启动中的：等它们落定后同样停掉（启动到一半的 worker 不允许成为孤儿）。
    const pending: Array<[string, Promise<WorkerEndpoint>]> = [...this.starting.entries()];
    if (pending.length > 0) {
      await Promise.allSettled(pending.map(([, promise]) => promise));
      await Promise.all(pending.map(([studentId]) => this.stop(studentId)));
    }
    livePools.delete(this);
  }
}
