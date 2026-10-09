import type { MobileConfiguration } from './configuration.js';
import { createMobileApp } from './router.js';
import { BailianMobileVision } from './vision.js';
import { PairingManager } from './pairing.js';
import { createAdminServer, type AdminServerHandle } from './adminServer.js';
import { getDb } from '../db/connection.js';
import { ensureStudentProfile } from '../services/studentService.js';
import { bridgePending } from '../bridge/recognitionToItems.js';
import { createV2Router } from '../v2/router.js';
import { resumePendingSnapshots } from '../v2/printService.js';
import { createWebClientRouter } from '../web/router.js';
import { getTranscriber, type SpeechTranscriber } from '../ai/asr.js';
import type { MobileVisionBoundary } from './vision.js';

/** 测试与本机试用的替身（合成识别、固定转写）；生产入口 main.ts 不传。 */
export interface CloudAssemblyOverrides {
  vision?: MobileVisionBoundary;
  transcriber?: SpeechTranscriber;
}

export interface CloudAssembly {
  configuration: MobileConfiguration;
  admin: AdminServerHandle;
  listen(): Promise<void>;
  close(): Promise<void>;
}

/**
 * 云端模式主进程装配：设备令牌鉴权接管公网入口 + 同进程内嵌管理入口。
 * v2.0 T2 起为单进程装配：同一端口同时服务 /v1 识别（语义不变）与 /v2 手机接口（设备令牌鉴权）。
 * 云端公网入口不挂旧的 Web 看板：/、/parent、/items、/trends 等一律走 404（F1，隐私要求）。
 * 2026-10-09 起挂学生网页版 /s/（设备令牌 cookie 鉴权，只有学生自己的页面，没有家长 / 管理页面）。
 * /v2 使用 node:sqlite 库 SEL_DATA_DIR/app.db；启动时若无学生档案则创建匿名档案（幂等）。
 * 回环模式仍走 server.ts / main.ts 的直装配，不经由此文件。
 */
export async function assembleCloudService(configuration: MobileConfiguration, overrides: CloudAssemblyOverrides = {}): Promise<CloudAssembly> {
  if (configuration.mode !== 'cloud') throw new Error('assembleCloudService 仅用于云端模式');
  // 共享 SQLite（SEL_DATA_DIR/app.db）：先建库再确保唯一学生档案，/v2 绑定到它。
  getDb();
  ensureStudentProfile();
  // T3：启动时把已登记但尚未桥接的 v2 识别任务补桥一次（单个失败不影响启动）。
  bridgePending(configuration.dataDir);
  // T5：重启后续做 preparing 状态的打印快照（已完成的题不重做）。
  resumePendingSnapshots();
  const pairing = await PairingManager.open(configuration.dataDir, { pairingUrl: configuration.pairingUrl });
  const admin = await createAdminServer(pairing);
  // 语音转写缺配置在这里就失败（启动即失败，不等到第一次录音）。
  const transcriber = overrides.transcriber ?? getTranscriber();
  const app = await createMobileApp({
    dataDir: configuration.dataDir, vision: overrides.vision ?? new BailianMobileVision(configuration.vision), mode: 'cloud', pairing, cloudProxy: true,
    v2Router: ({ limiter }) => createV2Router({ mobileDataDir: configuration.dataDir, transcriber, limiter }),
    // 学生网页版 /s/（2026-10-09）：同一进程、同一端口、同一 Caddy 站点。
    webClient: deps => createWebClientRouter({ ...deps, mobileDataDir: configuration.dataDir, transcriber }),
  });
  let server: Awaited<ReturnType<typeof app.listen>> | null = null;
  const listen = (): Promise<void> => new Promise((resolve, reject) => {
    if (server) { reject(new Error('云端服务已在监听，不能重复 listen')); return; }
    const onError = (error: Error): void => reject(error);
    app.once('error', onError);
    server = app.listen(configuration.port, configuration.host, () => { app.off('error', onError); resolve(); });
  });
  const close = async (): Promise<void> => {
    await app.locals.mobileRecognitionService.stop();
    await admin.close();
    const current = server;
    server = null;
    if (current) await new Promise<void>((resolve, reject) => {
      current.once('error', reject);
      current.close(() => { current.off('error', reject); resolve(); });
    });
  };
  return { configuration, admin, listen, close };
}
