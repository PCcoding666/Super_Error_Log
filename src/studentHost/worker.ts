/**
 * 学生空间 worker 子进程入口（由 studentHost/workers.ts fork；不要直接运行）。
 * - 父进程在 fork 时注入 SEL_STUDENT_DATA_DIR；本进程在加载任何业务模块前把它固定到
 *   SEL_DATA_DIR / SEL_MOBILE_DATA_DIR（config.ts 在 import 时读环境变量，所以这里只能动态 import）。
 * - 每个 worker 只服务一个学生：独立目录、独立数据库、独立识别/打印/AI provider 缓存，互不串。
 * - 只监听 127.0.0.1 随机端口；就绪后通过 IPC 回 {type:'ready',port,token}。
 *   token 是用本 worker 自己的 PairingManager 签发的内部设备令牌，只有父进程知道，绝不发给浏览器。
 * - SEL_STUDENT_HOST_ENABLED 在这里被强制关掉：worker 绝不递归启动邀请码网关。
 * - SEL_STUDENT_WORKER_FAKE=1（仅测试）：用合成识别与 mock 转写，不碰真实模型、不需要密钥。
 * - 父进程 IPC 断开（父进程退出/被杀）时自行退出，不留孤儿进程。
 */
import crypto from 'node:crypto';
import type { MobileConfiguration } from '../mobile/configuration.js';
import type { CloudAssembly } from '../mobile/cloudAssembly.js';
import type { PairingManager } from '../mobile/pairing.js';
import type { InventoryCandidate, MobileVisionBoundary, VisionContext, VisionInventoryResult, VisionQuestionResult } from '../mobile/vision.js';
import { installParentPermitListener } from './parentPermit.js';

interface ParentMessage { type?: string; force?: boolean }

function send(message: Record<string, unknown>): void {
  try {
    if (process.send) process.send(message, () => undefined);
  } catch { /* 父进程已走：等 disconnect 兜底退出 */ }
}

/** 测试用合成识别（与 tests/integration 里的夹具同一形状）：一张卷子一道题，等待学生勾。 */
class SyntheticWorkerVision implements MobileVisionBoundary {
  readonly configured = true;
  async inventory(source: Buffer, _context: VisionContext): Promise<VisionInventoryResult> {
    return { candidates: [{ number: '1', box: { x: 0, y: 0, width: 1, height: 1 }, selectionEvidence: 'unmarked', partial: false }], warnings: [] };
  }
  async recognizeQuestion(source: Buffer, candidate: InventoryCandidate, _context: VisionContext): Promise<VisionQuestionResult> {
    return {
      evidence: {
        version: 1, questionNumber: candidate.number, questionText: '求 x 的值。', subject: '数学', chapter: '',
        knowledgeTags: [], questionType: '计算', questionRegion: candidate.box, requiresDiagram: false,
        regions: [], observations: [], uncertainties: [],
      },
      verification: { textComplete: true, questionCropComplete: true, questionCropPure: true, transcriptionMatches: true, diagramSafe: true, issues: [] },
      questionCrop: source, diagramCrops: [],
    };
  }
}

/** 用本 worker 自己的 PairingManager 签内部设备令牌（createSession + 立即 redeem，复用已验证的配对路径）。 */
async function issueInternalToken(pairing: PairingManager): Promise<string> {
  const session = pairing.createSession();
  const result = await pairing.redeem(session.payload, crypto.randomUUID(), 'student-host-worker');
  return result.token;
}

async function main(): Promise<void> {
  // 父进程退出/被杀 → IPC 断开 → 跟着退出，不留孤儿。启动完成前就挂上：启动期父进程死了也不能留。
  let assembly: CloudAssembly | null = null;
  let stopping = false;
  const shutdown = async (code: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try { if (assembly) await assembly.close(); } finally { process.exit(code); }
  };
  process.on('disconnect', () => void shutdown(0));

  const studentDir = process.env.SEL_STUDENT_DATA_DIR ?? '';
  if (!studentDir) {
    send({ type: 'error', message: 'worker 缺少 SEL_STUDENT_DATA_DIR' });
    process.exit(2);
  }
  // 必须在任何业务模块加载前固定（config.ts 在 import 时读环境变量）。
  process.env.SEL_DATA_DIR = studentDir;
  process.env.SEL_MOBILE_DATA_DIR = studentDir;
  process.env.SEL_STUDENT_HOST_ENABLED = '0';
  process.env.SEL_STUDENT_WORKER = '1';

  const { assembleCloudService } = await import('../mobile/cloudAssembly.js');
  // 合成识别只允许在测试环境开启（防生产误配降级）：NODE_ENV=test 且 AI mock 双条件。
  const fake = process.env.SEL_STUDENT_WORKER_FAKE === '1';
  if (fake && (process.env.NODE_ENV !== 'test' || process.env.SEL_AI_MODE !== 'mock')) {
    send({ type: 'error', message: 'SEL_STUDENT_WORKER_FAKE 只允许测试环境（NODE_ENV=test 且 SEL_AI_MODE=mock）' });
    process.exit(2);
  }
  let configuration: MobileConfiguration;
  let vision: MobileVisionBoundary | undefined;
  if (fake) {
    configuration = {
      mode: 'cloud', host: '127.0.0.1', port: 0, dataDir: studentDir, pairingToken: '',
      vision: {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'synthetic', timeoutMs: 1000, bailianOnly: true,
        models: { inventory: 'm', transcribe: 'm', verify: 'm', ground: 'm' },
      },
    };
    vision = new SyntheticWorkerVision();
  } else {
    const { loadMobileConfiguration } = await import('../mobile/configuration.js');
    configuration = { ...loadMobileConfiguration(), mode: 'cloud', host: '127.0.0.1', port: 0, dataDir: studentDir };
  }
  // worker 不需要管理 socket（深层目录下 unix socket 路径可能超过系统限制；管理操作由父进程经 IPC 完成）。
  assembly = await assembleCloudService(configuration, { ...(vision ? { vision } : {}), adminServer: false });
  await assembly.listen();
  const port = assembly.boundPort();
  if (!port) throw new Error('worker 未能取得监听端口');
  const running: CloudAssembly = assembly;
  const token = await issueInternalToken(running.pairing);
  installParentPermitListener();
  // printService 会连带加载 config（import 时读环境变量），必须等数据目录固定后再动态引入。
  const busy = async (): Promise<boolean> => {
    const { printWorkPending } = await import('../v2/printService.js');
    return running.recognition.hasPendingRecognition() || printWorkPending();
  };
  send({ type: 'ready', port, token });

  process.on('message', (message: ParentMessage) => {
    if (message?.type === 'refresh-token') {
      void issueInternalToken(running.pairing)
        .then(next => send({ type: 'token', token: next }))
        .catch(() => send({ type: 'error', message: '内部令牌刷新失败' }));
      return;
    }
    if (message?.type === 'query-busy') {
      void busy().then(value => send({ type: 'busy', busy: value })).catch(() => send({ type: 'busy', busy: true }));
      return;
    }
    if (message?.type === 'stop') {
      if (message.force === true) { void shutdown(0); return; }
      // 空闲退出：有排队、在跑或等待重试的识别/打印时拒绝，任务留在本学生目录里，下次启动续做。
      void busy().then(value => {
        if (value) { send({ type: 'stop-refused' }); return; }
        void shutdown(0);
      }).catch(() => send({ type: 'stop-refused' }));
    }
  });
}

main().catch((error: unknown) => {
  send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
