import { config } from './config.js';
import { getDb } from './db/connection.js';
import { ensureStudentProfile } from './services/studentService.js';
import { bridgePending } from './bridge/recognitionToItems.js';
import { loadMobileConfiguration } from './mobile/configuration.js';
import { assembleCloudService } from './mobile/cloudAssembly.js';
import { createMobileApp } from './mobile/router.js';
import { BailianMobileVision } from './mobile/vision.js';
import { createV2Router } from './v2/router.js';
import { resumePendingSnapshots } from './v2/printService.js';
import { assertV2AiConfigured } from './v2/aiConfigGuard.js';
import { assertAsrConfigured } from './ai/asr.js';

// v2.0 T2 单进程入口：一个 Node 进程同时提供 /v1 识别（语义不变）与 /v2 手机接口，
// 共享 node:sqlite 库 SEL_DATA_DIR/app.db。云端公网入口不挂旧的 Web 看板（F1）。
// help.pccoding666.com 的 GET / 是公开说明页，见 src/portal/helpPortal.ts。
// 缺配置一律 fail-hard，禁止降级为 mock。
assertV2AiConfigured(config);
// 学生网页版的语音转写（/v2/reflections/transcribe、/s/voice）同样缺配置即拒绝启动。
assertAsrConfigured(config);
const configuration = loadMobileConfiguration();

if (configuration.mode === 'cloud') {
  const service = await assembleCloudService(configuration);
  await service.listen();
  console.log(`单进程服务已启动：http://${configuration.host}:${configuration.port}（模式：cloud，/v1 + /v2）`);
  if (service.admin) console.log(`云端管理入口已监听：${service.admin.socketPath}`);
  if (process.env.SEL_STUDENT_HOST_ENABLED === '1') console.log('学生邀请码网页已接管 /s（每学生独立空间）；旧单学生网页不再直接暴露。');
  const shutdown = async (): Promise<void> => {
    try { await service.close(); } finally { process.exit(0); }
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
} else {
  // 回环模式（本机模拟器）：/v1 + /v2，共享令牌鉴权；同样确保唯一学生档案。
  getDb();
  ensureStudentProfile();
  // T3：启动时把已登记但尚未桥接的 v2 识别任务补桥一次（单个失败不影响启动）。
  bridgePending(configuration.dataDir);
  // T5：重启后续做 preparing 状态的打印快照（已完成的题不重做）。
  resumePendingSnapshots();
  const app = await createMobileApp({ dataDir: configuration.dataDir, pairingToken: configuration.pairingToken, vision: new BailianMobileVision(configuration.vision), v2Router: () => createV2Router({ mobileDataDir: configuration.dataDir }) });
  app.listen(configuration.port, configuration.host, () => {
    console.log(`单进程服务已启动：http://${configuration.host}:${configuration.port}（模式：loopback，/v1 + /v2）`);
  });
}
