import type { AddressInfo } from 'node:net';
import type { MobileConfiguration } from './configuration.js';
import { createMobileApp } from './router.js';
import { BailianMobileVision } from './vision.js';
import { PairingManager } from './pairing.js';
import { createAdminServer, type AdminServerHandle } from './adminServer.js';
import { createStudentHostGateway, type StudentHostGateway } from '../studentHost/router.js';
import { resolveStudentHostDir } from '../studentHost/registry.js';
import { getDb } from '../db/connection.js';
import { ensureStudentProfile } from '../services/studentService.js';
import { bridgePending } from '../bridge/recognitionToItems.js';
import { createV2Router } from '../v2/router.js';
import { resumePendingSnapshots } from '../v2/printService.js';
import { createWebClientRouter } from '../web/router.js';
import { getTranscriber, type SpeechTranscriber } from '../ai/asr.js';
import type { MobileVisionBoundary } from './vision.js';
import { MaterialStore } from '../materials/store.js';
import type { MaterialJobs } from '../materials/jobs.js';
import type { MaterialUploads } from '../materials/uploads.js';

/** 测试与本机试用的替身（合成识别、固定转写）；生产入口 main.ts 不传。 */
export interface CloudAssemblyOverrides {
  vision?: MobileVisionBoundary;
  configureMaterials?: (jobs: MaterialJobs, uploads: MaterialUploads) => void;
  transcriber?: SpeechTranscriber;
  /** 学生空间 worker（studentHost/worker.ts）不需要管理 socket：深层目录下 unix socket 路径可能超长。 */
  adminServer?: boolean;
}

export interface CloudAssembly {
  configuration: MobileConfiguration;
  admin: AdminServerHandle | null;
  /** 设备令牌管理（学生空间 worker 用它签发只有父进程知道的内部令牌）。 */
  pairing: PairingManager;
  listen(): Promise<void>;
  /** 实际监听的端口（configuration.port 传 0 时由系统分配）；未监听返回 null。 */
  boundPort(): number | null;
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
  const materialStore = new MaterialStore(getDb(), ensureStudentProfile().id);
  // T3：启动时把已登记但尚未桥接的 v2 识别任务补桥一次（单个失败不影响启动）。
  bridgePending(configuration.dataDir);
  // T5：重启后续做 preparing 状态的打印快照（已完成的题不重做）。
  resumePendingSnapshots();
  const pairing = await PairingManager.open(configuration.dataDir, { pairingUrl: configuration.pairingUrl });
  const admin = overrides.adminServer === false ? null : await createAdminServer(pairing);
  // 语音转写缺配置在这里就失败（启动即失败，不等到第一次录音）。
  const transcriber = overrides.transcriber ?? getTranscriber();
  // 2026-10-15 学生邀请码网页：SEL_STUDENT_HOST_ENABLED=1 时 /s 换成「邀请码登录 + 独立学生空间转发」网关，
  // 本进程自己的单学生 /s 不再直接暴露（/v1 /v2 旧 App 接口保持不变）。worker 进程绝不带这个 flag（不递归）。
  const studentHost: StudentHostGateway | null = process.env.SEL_STUDENT_HOST_ENABLED === '1'
    ? await createStudentHostGateway({ hostDir: resolveStudentHostDir(configuration.dataDir) })
    : null;
  const app = await createMobileApp({
    materialStore, configureMaterials: overrides.configureMaterials,
    dataDir: configuration.dataDir, vision: overrides.vision ?? new BailianMobileVision(configuration.vision), mode: 'cloud', pairing, cloudProxy: true,
    v2Router: ({ limiter }) => createV2Router({ mobileDataDir: configuration.dataDir, transcriber, limiter }),
    // 学生网页版 /s/（2026-10-09）：同一进程、同一端口、同一 Caddy 站点。
    // studentHost 网关开启时由网关接管 /s；studentHostWorker 标记只出现在 worker 进程里（设置页显示「退出登录」）。
    webClient: studentHost
      ? deps => studentHost.router({ limiter: deps.limiter, ipOf: deps.ipOf, originScheme: 'https:' })
      : deps => createWebClientRouter({ ...deps, mobileDataDir: configuration.dataDir, transcriber, studentHostWorker: process.env.SEL_STUDENT_WORKER === '1' }),
  });
  let server: Awaited<ReturnType<typeof app.listen>> | null = null;
  const listen = (): Promise<void> => new Promise((resolve, reject) => {
    if (server) { reject(new Error('云端服务已在监听，不能重复 listen')); return; }
    const onError = (error: Error): void => reject(error);
    app.once('error', onError);
    server = app.listen(configuration.port, configuration.host, () => { app.off('error', onError); resolve(); });
  });
  const boundPort = (): number | null => {
    const address = server?.address();
    return address && typeof address === 'object' ? (address as AddressInfo).port : null;
  };
  const close = async (): Promise<void> => {
    // 先停学生 worker（不再接新请求后再杀子进程，避免半截 multipart 写入）。
    if (studentHost) await studentHost.close();
    await app.locals.mobileRecognitionService.stop();
    if (admin) await admin.close();
    const current = server;
    server = null;
    if (current) await new Promise<void>((resolve, reject) => {
      current.once('error', reject);
      current.close(() => { current.off('error', reject); resolve(); });
    });
  };
  return { configuration, admin, pairing, listen, boundPort, close };
}
