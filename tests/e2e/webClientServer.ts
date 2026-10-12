/**
 * 学生网页版的合成服务器（Playwright 与本机试用都用它）：真实的云端装配（assembleCloudService：/v1 + /v2 + /s/、
 * 设备令牌、管理 socket），只把识别换成合成实现、把语音转写换成 mock 的固定句子。不连任何真实模型、不读 .env 与 data/。
 *
 *   npm run web:fake            # 打印一条配对链接，用手机尺寸的浏览器打开即可试用
 *
 * 合成照片：偏红的图 = 有批改痕迹的卷子（3 道红叉题，自动精读）；偏蓝的图 = 没批改的答题卡页（3 道都要学生自己勾）。
 * 控制口（只监听 127.0.0.1，测试专用，不在生产代码里）：
 *   GET  /pairing-link        经管理 socket 生成一次性配对码，返回网页版配对链接
 *   POST /time-travel?days=7  把已有记录整体往前挪 N 天（等于过了 N 天），用来走「下个周末」
 *   GET  /trail               网页版互动记录（audit_event 里 web_* 的行：时间、类型、路由模板#动作、设备 ID），给 E2E 断言用
 *   故障注入（quality round 2：截错误 / 等待状态、测局部轮询）：
 *   POST /fault?vision=hold      之后上传的照片停在「AI 正在找题」，直到 vision=release
 *   POST /fault?vision=release   放行（停住的照片接着找题）
 *   POST /fault?vision=fail&count=1        之后 count 张照片找题失败（可以重试：「这张没识别成功」）
 *   POST /fault?vision=unreadable&count=1  之后 count 张照片读不出来（不能重试：「这张识别不了」）
 *   POST /fault?asr=fail | asr=ok           语音转写失败（/s/voice 回 502）/ 恢复
 *   POST /fault?asr=hold | asr=release      转写停在「正在转成文字」，直到 release
 *   POST /fault?print=preparing&done=1      把最近一份练习的打印快照改成「准备中」（第 done 道；开始时间改成 40 秒前）
 *   POST /fault?print=failed                改成「准备失败」（服务器原文是合成的）
 *   POST /fault?print=restore               恢复成注入之前的样子
 *   POST /fault?reset=1                     全部恢复正常
 *   GET  /fault                             现在注入了什么
 *   打印快照的注入直接改数据库里的那一行（并把这份练习的 generated_at 暂时清空，和真的还没生成时一样），restore 时放回原样。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.env.SEL_WEB_E2E_PORT ?? 3198);
const controlPort = Number(process.env.SEL_WEB_E2E_CONTROL_PORT ?? port + 1);
const root = path.join(os.tmpdir(), `sel-web-e2e-${port}`);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'db'), { recursive: true });
// 必须在加载应用模块之前设好：config.ts 在导入时读取。
process.env.SEL_AI_MODE = 'mock';
process.env.SEL_DATA_DIR = path.join(root, 'db');
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[key];

const sharp = (await import('sharp')).default;
const { assembleCloudService } = await import('../../src/mobile/cloudAssembly.js');
const { MockTranscriber } = await import('../../src/ai/asr.js');
const { webPairingLink } = await import('../../src/mobile/pairing.js');
const { cropPhoto } = await import('../../src/media/images.js');
const { getDb } = await import('../../src/db/connection.js');
const { isoWeekKey } = await import('../../src/domain/scheduling.js');
const { readTrail } = await import('../../src/web/trail.js');
const { MobileVisionError } = await import('../../src/mobile/vision.js');
const { TranscribeError } = await import('../../src/ai/asr.js');
type Vision = import('../../src/mobile/vision.js').MobileVisionBoundary;
type Candidate = import('../../src/mobile/vision.js').InventoryCandidate;
type Evidence = import('../../src/ai/evidence.js').Evidence;

const TOPICS = [
  { tag: '一元一次方程', text: (n: number) => `解方程：${n}x + 3 = ${n * 2 + 3}，求 x 的值。` },
  { tag: '二次函数', text: (n: number) => `已知二次函数 y = x² - ${n}x + 2，求它的对称轴。` },
  { tag: '相似三角形', text: (n: number) => `△ABC ∽ △DEF，AB = ${n}，DE = ${n * 2}，求相似比。` },
];

/** 故障注入的开关（只在这个合成服务器里）。 */
const faults = {
  visionHold: null as null | { promise: Promise<void>; release: () => void },
  visionFail: 0,
  visionUnreadable: 0,
  asrFail: false,
  asrHold: null as null | { promise: Promise<void>; release: () => void },
  print: null as null | { packetId: string; row: Record<string, unknown> },
};

/** 合成识别：按照片颜色决定这一页有没有批改痕迹；题目、作答全部是编的。 */
class SyntheticVision implements Vision {
  readonly configured = true;
  readonly supportsCancellation = false;
  async inventory(source: Buffer): Promise<{ candidates: Candidate[]; warnings: string[] }> {
    if (faults.visionHold) await faults.visionHold.promise;
    if (faults.visionUnreadable > 0) { faults.visionUnreadable -= 1; throw new MobileVisionError('invalid_image', '照片太模糊，看不清题目', 'inventory', false); }
    if (faults.visionFail > 0) { faults.visionFail -= 1; throw new MobileVisionError('invalid_output', '模型输出字段不合法：candidates', 'inventory', false); }
    const stats = await sharp(source).stats();
    const marked = (stats.channels[0]?.mean ?? 0) >= (stats.channels[2]?.mean ?? 0);
    const offset = marked ? 1 : 4;
    const candidates = [0, 1, 2].map(index => ({
      number: String(index + offset),
      box: { x: 0.08, y: 0.06 + index * 0.31, width: 0.84, height: 0.27 },
      confidence: 0.9,
      selectionEvidence: marked ? 'marked_wrong' as const : 'unmarked' as const,
      partial: false,
    }));
    return { candidates, warnings: [] };
  }
  async recognizeQuestion(source: Buffer, candidate: Candidate) {
    const n = Number(candidate.number);
    const topic = TOPICS[(n - 1) % TOPICS.length]!;
    const evidence: Evidence = {
      version: 1, questionNumber: candidate.number, questionText: topic.text(n), subject: '数学', chapter: '', knowledgeTags: [topic.tag],
      questionType: '计算', questionRegion: candidate.box, requiresDiagram: false,
      regions: [{ id: 's1', kind: 'student_work', box: { x: candidate.box.x + 0.5, y: candidate.box.y + 0.1, width: 0.2, height: 0.1 }, confidence: 0.9, cleanForPrint: false }],
      observations: [{ id: 'o1', kind: 'student_work', text: `x = ${n + 1}`, regionId: 's1', confidence: 0.9 }],
      uncertainties: [],
    };
    const verification = { textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] as string[] };
    return { evidence, verification, questionCrop: await cropPhoto(source, candidate.box), diagramCrops: [] as Buffer[] };
  }
}

/** mock 转写；asr=fail 时像真实转写服务出错一样抛 TranscribeError（/s/voice 回 502）。 */
class SwitchableTranscriber {
  readonly source = 'mock' as const;
  private readonly inner = new MockTranscriber();
  async transcribe(audio: Buffer, _mimeType: string): Promise<string> {
    if (faults.asrHold) await faults.asrHold.promise;
    if (faults.asrFail) throw new TranscribeError('provider_error', '合成故障：转写服务没响应');
    return this.inner.transcribe(audio);
  }
}

/** 打印快照注入：改最近一份练习的 v2_print_snapshot 那一行；restore 时放回原样。 */
function injectPrint(state: string, done: number): string {
  const db = getDb();
  if (state === 'restore') {
    if (!faults.print) return 'nothing to restore';
    const { packetId, row } = faults.print;
    db.prepare('UPDATE v2_print_snapshot SET status = ?, progress_done = ?, progress_total = ?, snapshot_json = ?, error = ?, created_at = ?, ready_at = ? WHERE packet_id = ?')
      .run(row.status as string, row.progress_done as number, row.progress_total as number, row.snapshot_json as string | null, row.error as string | null, row.created_at as string, row.ready_at as string | null, packetId);
    db.prepare('UPDATE review_packet SET generated_at = ? WHERE id = ?').run(row.generated_at as string | null, packetId);
    faults.print = null;
    return 'restored';
  }
  const latest = db.prepare('SELECT s.* FROM v2_print_snapshot s JOIN review_packet p ON p.id = s.packet_id ORDER BY p.created_at DESC LIMIT 1').get() as Record<string, unknown> | undefined;
  if (!latest) throw new Error('还没有打印快照：先建一份练习并开始准备练习纸');
  const packetId = latest.packet_id as string;
  if (!faults.print || faults.print.packetId !== packetId) {
    const generated = db.prepare('SELECT generated_at FROM review_packet WHERE id = ?').get(packetId) as { generated_at: string | null };
    faults.print = { packetId, row: { ...latest, generated_at: generated.generated_at } };
  }
  // 真的在准备 / 准备失败时练习纸还没生成：练习的 generated_at 也是空的。
  db.prepare('UPDATE review_packet SET generated_at = NULL WHERE id = ?').run(packetId);
  const total = Number(faults.print.row.progress_total) || 3;
  if (state === 'preparing') {
    const started = new Date(Date.now() - 40_000).toISOString();
    db.prepare("UPDATE v2_print_snapshot SET status = 'preparing', progress_done = ?, progress_total = ?, error = NULL, created_at = ? WHERE packet_id = ?").run(Math.min(done, total), total, started, packetId);
    return `preparing ${Math.min(done, total)}/${total}`;
  }
  if (state === 'failed') {
    db.prepare("UPDATE v2_print_snapshot SET status = 'failed', error = ? WHERE packet_id = ?").run('辅导服务暂时没响应（合成故障）', packetId);
    return 'failed';
  }
  throw new Error(`unknown print state ${state}`);
}

function releaseVision(): void {
  const hold = faults.visionHold;
  faults.visionHold = null;
  hold?.release();
}

const dataDir = path.join(root, 'mobile');
const service = await assembleCloudService({
  host: '127.0.0.1', port, dataDir, mode: 'cloud', pairingToken: '', pairingUrl: 'https://study.pccoding666.com',
  vision: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '', timeoutMs: 1000, bailianOnly: true, models: { inventory: '-', transcribe: '-', verify: '-', ground: '-' } },
}, { vision: new SyntheticVision(), transcriber: new SwitchableTranscriber() });
await service.listen();

function pairingCode(): Promise<{ payload: Parameters<typeof webPairingLink>[0] }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: service.admin.socketPath, path: '/pairing-code', method: 'GET' }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(raw)); } catch (error) { reject(error); } });
    });
    request.on('error', reject);
    request.end();
  });
}

/** 把记录整体往前挪 days 天（ISO 时间戳列；练习的 ISO 周按新的建包时间重算）。 */
function timeTravel(days: number): void {
  const db = getDb();
  const shift = `-${days} days`;
  const columns: Array<[string, string[]]> = [
    ['v2_photo', ['registered_at']], ['review_packet', ['created_at', 'generated_at']], ['v2_print_snapshot', ['created_at', 'ready_at']],
    ['error_item', ['created_at', 'updated_at']], ['error_diagnosis', ['created_at']], ['v2_reflection_turn', ['created_at', 'answered_at']],
    ['review_attempt', ['created_at']], ['mastery_event', ['created_at']],
  ];
  for (const [table, names] of columns) {
    for (const name of names) {
      try { db.prepare(`UPDATE ${table} SET ${name} = strftime('%Y-%m-%dT%H:%M:%fZ', ${name}, ?) WHERE ${name} IS NOT NULL`).run(shift); } catch { /* 列不存在就跳过 */ }
    }
  }
  for (const row of db.prepare('SELECT id, created_at FROM review_packet').all() as Array<{ id: string; created_at: string }>) {
    db.prepare('UPDATE review_packet SET week = ? WHERE id = ?').run(isoWeekKey(new Date(row.created_at)), row.id);
  }
}

const base = `http://127.0.0.1:${port}`;
http.createServer((request, response) => {
  void (async () => {
    try {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${controlPort}`);
      if (request.method === 'GET' && url.pathname === '/pairing-link') {
        const { payload } = await pairingCode();
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ link: webPairingLink(payload, base) }));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/trail') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(readTrail()));
        return;
      }
      if (url.pathname === '/fault') {
        const done: string[] = [];
        if (request.method === 'POST') {
          const q = url.searchParams;
          if (q.get('reset') === '1') { releaseVision(); faults.visionFail = 0; faults.visionUnreadable = 0; faults.asrFail = false; faults.asrHold?.release(); faults.asrHold = null; if (faults.print) injectPrint('restore', 0); done.push('reset'); }
          const vision = q.get('vision');
          const count = Math.max(1, Math.min(20, Number(q.get('count') ?? 1)));
          if (vision === 'hold' && !faults.visionHold) { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); faults.visionHold = { promise, release }; done.push('vision hold'); }
          if (vision === 'release') { releaseVision(); done.push('vision release'); }
          if (vision === 'fail') { faults.visionFail = count; done.push(`vision fail ×${count}`); }
          if (vision === 'unreadable') { faults.visionUnreadable = count; done.push(`vision unreadable ×${count}`); }
          if (vision === 'ok') { releaseVision(); faults.visionFail = 0; faults.visionUnreadable = 0; done.push('vision ok'); }
          const asr = q.get('asr');
          if (asr === 'fail' || asr === 'ok') { faults.asrFail = asr === 'fail'; done.push(`asr ${asr}`); }
          if (asr === 'hold' && !faults.asrHold) { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); faults.asrHold = { promise, release }; done.push('asr hold'); }
          if ((asr === 'release' || asr === 'ok') && faults.asrHold) { const hold = faults.asrHold; faults.asrHold = null; hold.release(); done.push('asr release'); }
          const print = q.get('print');
          if (print) done.push(injectPrint(print, Math.max(0, Number(q.get('done') ?? 1))));
        }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ done, visionHold: faults.visionHold !== null, visionFail: faults.visionFail, visionUnreadable: faults.visionUnreadable, asrFail: faults.asrFail, print: faults.print ? 'injected' : null }));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/time-travel') {
        timeTravel(Math.max(1, Math.min(60, Number(url.searchParams.get('days') ?? 7))));
        response.end('ok');
        return;
      }
      response.statusCode = 404;
      response.end('not found');
    } catch (error) {
      response.statusCode = 500;
      response.end(String(error));
    }
  })();
}).listen(controlPort, '127.0.0.1');

const { payload } = await pairingCode();
console.log(`学生网页版合成服务器：${base}/s/`);
console.log(`配对链接（5 分钟内有效，单次使用；再要一条：curl http://127.0.0.1:${controlPort}/pairing-link）：`);
console.log(webPairingLink(payload, base));

const stop = async (): Promise<void> => {
  try { await service.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); process.exit(0); }
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
