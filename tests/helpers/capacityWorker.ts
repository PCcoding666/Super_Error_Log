/**
 * 只做 IPC 的假 worker。不加载业务模块，用来测空闲退出和父进程信号量。
 * 父进程发 query-busy / stop；测试经 please-acquire / please-release 让它去排队。
 */
let busy = process.env.SEL_FAKE_BUSY === '1';

function send(message: Record<string, unknown>): void {
  process.send?.(message);
}

const granted: string[] = [];

// 真 worker 一启动就跑后台队列（详情页解答预生成）、续做打印、恢复识别扫描：名额申请发生在 send(ready) 之前。
// SEL_FAKE_ACQUIRE_BEFORE_READY=<id>：先申请视觉名额再报 ready；SEL_FAKE_DIE_AFTER_ACQUIRE=1：申请完就退出（启动失败）。
if (process.env.SEL_FAKE_ACQUIRE_BEFORE_READY) {
  const id = process.env.SEL_FAKE_ACQUIRE_BEFORE_READY;
  if (process.env.SEL_FAKE_DIE_AFTER_ACQUIRE === '1') { process.send?.({ type: 'acquire', kind: 'ai', id, background: true }, () => process.exit(1)); }
  else send({ type: 'acquire', kind: 'ai', id, background: true });
}
if (process.env.SEL_FAKE_DIE_AFTER_ACQUIRE !== '1') send({ type: 'ready', port: 9, token: 'capacity-worker' });

process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object') return;
  const body = message as { type?: string; force?: boolean; busy?: boolean; kind?: string; id?: string };
  if (body.type === 'query-busy') { send({ type: 'busy', busy }); return; }
  if (body.type === 'set-busy') { busy = body.busy === true; return; }
  if (body.type === 'stop') {
    if (busy && body.force !== true) { send({ type: 'stop-refused' }); return; }
    const delay = Number(process.env.SEL_FAKE_STOP_DELAY_MS ?? '0');
    if (delay > 0) {
      send({ type: 'stopping' });
      setTimeout(() => process.exit(0), delay);
      return;
    }
    process.exit(0);
  }
  if (body.type === 'please-acquire') { send({ type: 'acquire', kind: body.kind, id: body.id }); return; }
  if (body.type === 'please-release') { send({ type: 'release', kind: body.kind, id: body.id }); return; }
  if (body.type === 'permit') { granted.push(String(body.id)); send({ type: 'granted', id: body.id }); return; }
  if (body.type === 'please-list-granted') { send({ type: 'granted-list', ids: granted }); return; }
  if (body.type === 'refresh-token') { send({ type: 'token', token: 'refreshed' }); }
});
