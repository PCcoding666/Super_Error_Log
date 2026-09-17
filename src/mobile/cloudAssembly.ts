import { loadMobileConfiguration, type MobileConfiguration } from './configuration.js';
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
  const listen = (): Promise<void> => new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    app.once('error', onError);
    app.listen(configuration.port, configuration.host, () => { app.off('error', onError); resolve(); });
  });
  const close = async (): Promise<void> => {
    await admin.close();
    // Express 本身不持有 server 句柄；listen 后的关闭由调用方管理（进程退出场景）。
  };
  return { configuration, admin, listen, close };
}
