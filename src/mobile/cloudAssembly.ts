import type { MobileConfiguration } from './configuration.js';
import { createMobileApp } from './router.js';
import { BailianMobileVision } from './vision.js';
import { PairingManager } from './pairing.js';
import { createAdminServer, type AdminServerHandle } from './adminServer.js';

export interface CloudAssembly {
  configuration: MobileConfiguration;
  admin: AdminServerHandle;
  listen(): Promise<void>;
  close(): Promise<void>;
}

/**
 * 云端模式主进程装配（Task 2）：设备令牌鉴权接管公网入口 + 同进程内嵌管理入口。
 * 回环模式仍走 server.ts 的直装配，不经由此文件。
 */
export async function assembleCloudService(configuration: MobileConfiguration): Promise<CloudAssembly> {
  if (configuration.mode !== 'cloud') throw new Error('assembleCloudService 仅用于云端模式');
  const pairing = await PairingManager.open(configuration.dataDir);
  const admin = await createAdminServer(pairing);
  const app = await createMobileApp({ dataDir: configuration.dataDir, vision: new BailianMobileVision(configuration.vision), mode: 'cloud', pairing, cloudProxy: true });
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
