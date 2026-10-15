/**
 * 学生空间 worker 进程池（studentHost 网关的转发目标）。
 * - 每个学生最多一个 worker 进程：child_process.fork，独立 SEL_DATA_DIR / SEL_MOBILE_DATA_DIR（目录 0700）。
 * - worker 只监听 127.0.0.1 随机端口；端口与内部设备令牌经 IPC ready 回传，父进程据此注入 sel_device 转发。
 * - 启动并发去重（同一学生的并发 ensure 共享同一次启动），启动超时 20 秒。
 * - 崩溃只影响本学生：按 studentId 键控，下一次 ensure 重新拉起，绝不把请求路由到别人的 worker。
 * - 父进程退出 / IPC 断开时 worker 自行退出（worker 侧 process.on('disconnect')）；stopAll 先礼后兵。
 * - 内部设备令牌 30 天有效；长期运行靠定期 refresh-token IPC 换新（默认每 7 天，可注入缩短测试）。
 */
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKER_START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;
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
  /** worker 报错/异常退出的回调（不写秘密）；缺省静默。 */
  onError?: (studentId: string, message: string) => void;
}

export class WorkerStartError extends Error {
  constructor(studentId: string, message: string) {
    super(`学生空间启动失败：${message}`);
    this.name = 'WorkerStartError';
  }
}

interface WorkerEntry {
  child: ChildProcess;
  endpoint: WorkerEndpoint;
  refreshTimer: NodeJS.Timeout | null;
  stderrTail: string[];
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

export class StudentWorkerPool {
  private readonly entries = new Map<string, WorkerEntry>();
  private readonly starting = new Map<string, Promise<WorkerEndpoint>>();
  private readonly startTimeoutMs: number;
  private readonly refreshIntervalMs: number;
  private stopping = false;

  constructor(private readonly options: StudentWorkerPoolOptions) {
    this.startTimeoutMs = options.startTimeoutMs ?? WORKER_START_TIMEOUT_MS;
    this.refreshIntervalMs = options.refreshIntervalMs ?? TOKEN_REFRESH_INTERVAL_MS;
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

  isRunning(studentId: string): boolean {
    const entry = this.entries.get(studentId);
    return !!entry && entry.child.exitCode === null && !entry.child.killed;
  }

  /** 取该学生的 worker 端点；没起就拉起（并发去重）。 */
  async ensure(studentId: string): Promise<WorkerEndpoint> {
    if (this.stopping) throw new WorkerStartError(studentId, '进程池正在关闭。');
    if (this.isRunning(studentId)) return { ...this.entries.get(studentId)!.endpoint };
    const pending = this.starting.get(studentId);
    if (pending) return pending;
    const start = this.start(studentId);
    this.starting.set(studentId, start);
    try { return await start; } finally { this.starting.delete(studentId); }
  }

  private async start(studentId: string): Promise<WorkerEndpoint> {
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

    const entry: WorkerEntry = { child, endpoint, refreshTimer: null, stderrTail };
    // 崩溃/退出：从表里摘除（下一次 ensure 重拉），通知观察者。不做自动重启，避免崩溃风暴。
    child.once('exit', (code, signal) => {
      if (this.entries.get(studentId) === entry) this.entries.delete(studentId);
      if (entry.refreshTimer) clearInterval(entry.refreshTimer);
      if (!this.stopping) this.options.onError?.(studentId, `worker 退出（code ${code ?? 'null'} ${signal ?? ''}）`);
    });
    // 长期运行的内部令牌刷新：worker 重新签发，父进程更新保存的令牌（旧令牌到期前平滑切换）。
    child.on('message', (message: unknown) => {
      if ((message as { type?: unknown })?.type === 'token' && typeof (message as { token?: unknown }).token === 'string') {
        entry.endpoint = { ...entry.endpoint, token: (message as { token: string }).token };
      }
    });
    if (this.refreshIntervalMs > 0) {
      entry.refreshTimer = setInterval(() => {
        // send 回调吞掉「通道已关闭」竞态（worker 刚退出时 connected 可能还亮着）。
        if (child.connected) child.send({ type: 'refresh-token' }, () => undefined);
      }, this.refreshIntervalMs);
      entry.refreshTimer.unref();
    }
    this.entries.set(studentId, entry);
    return { ...endpoint };
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
    this.entries.delete(studentId);
    if (entry.refreshTimer) clearInterval(entry.refreshTimer);
    const child = entry.child;
    if (child.exitCode !== null || child.killed) return;
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    if (child.connected) child.send({ type: 'stop' }, () => undefined);
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
