import type { MobileConfiguration } from './configuration.js';
import { createMobileApp } from './router.js';
import { BailianMobileVision } from './vision.js';
import { PairingManager } from './pairing.js';
import { createAdminServer, type AdminServerHandle } from './adminServer.js';
import { getDb } from '../db/connection.js';
import { ensureStudentProfile } from '../services/studentService.js';
import { createV2Router } from '../v2/router.js';

export interface CloudAssembly {
  configuration: MobileConfiguration;
  admin: AdminServerHandle;
  listen(): Promise<void>;
  close(): Promise<void>;
}

/**
 * 云端模式主进程装配：设备令牌鉴权接管公网入口 + 同进程内嵌管理入口。
 * v2.0 T2 起为单进程装配：同一端口同时服务 /v1 识别（语义不变）与 /v2 手机接口（设备令牌鉴权）。
 * 云端公网入口不挂任何 Web 页面：/、/parent、/items、/trends 等一律走 404（F1，隐私要求）。
 * /v2 使用 node:sqlite 库 SEL_DATA_DIR/app.db；启动时若无学生档案则创建匿名档案（幂等）。
 * 回环模式仍走 server.ts / main.ts 的直装配，不经由此文件。
 */
export async function assembleCloudService(configuration: MobileConfiguration): Promise<CloudAssembly> {
  if (configuration.mode !== 'cloud') throw new Error('assembleCloudService 仅用于云端模式');
  // 共享 SQLite（SEL_DATA_DIR/app.db）：先建库再确保唯一学生档案，/v2 绑定到它。
  getDb();
  ensureStudentProfile();
  const pairing = await PairingManager.open(configuration.dataDir);
  const admin = await createAdminServer(pairing);
  const app = await createMobileApp({ dataDir: configuration.dataDir, vision: new BailianMobileVision(configuration.vision), mode: 'cloud', pairing, cloudProxy: true, v2Router: createV2Router });
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
