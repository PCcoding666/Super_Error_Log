import { loadMobileConfiguration } from './configuration.js';
import { createMobileApp } from './router.js';
import { BailianMobileVision } from './vision.js';
import { PairingManager } from './pairing.js';
import { createAdminServer } from './adminServer.js';

const configuration = loadMobileConfiguration();
const app = await createMobileApp({ dataDir: configuration.dataDir, pairingToken: configuration.pairingToken, vision: new BailianMobileVision(configuration.vision) });
let admin: Awaited<ReturnType<typeof createAdminServer>> | null = null;
if (configuration.mode === 'cloud') {
  // 云端模式：打开设备令牌管理入口（Unix socket，仅本机）。公网 /v1 路由的设备令牌鉴权在 Task 2 接入；
  // 当前公网入口沿用共享令牌校验，但云端模式下不配置共享令牌即无法通过校验，等价于不对外提供公网服务。
  const pairing = await PairingManager.open(configuration.dataDir);
  admin = await createAdminServer(pairing);
  console.log(`云端管理入口已监听：${admin.socketPath}（serviceId ${pairing.serviceId}）`);
}
app.listen(configuration.port, configuration.host, () => {
  console.log(`移动识别服务已启动：http://${configuration.host}:${configuration.port}（模式：${configuration.mode}）`);
});
const shutdown = async (): Promise<void> => {
  if (admin) await admin.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
