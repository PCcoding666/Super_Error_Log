import { loadMobileConfiguration } from './configuration.js';
import { createMobileApp } from './router.js';
import { BailianMobileVision } from './vision.js';
import { assembleCloudService } from './cloudAssembly.js';

// 回环模式：直装配（共享令牌）。
// 云端模式：Task 2 起启用设备令牌鉴权 + 同进程 admin Unix socket 入口。
const configuration = loadMobileConfiguration();
if (configuration.mode === 'cloud') {
  const service = await assembleCloudService(configuration);
  await service.listen();
  console.log(`移动识别服务已启动：http://${configuration.host}:${configuration.port}（模式：cloud）`);
  console.log(`云端管理入口已监听：${service.admin.socketPath}`);
  const shutdown = async (): Promise<void> => {
    try { await service.close(); } finally { process.exit(0); }
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
} else {
  const app = await createMobileApp({ dataDir: configuration.dataDir, pairingToken: configuration.pairingToken, vision: new BailianMobileVision(configuration.vision) });
  app.listen(configuration.port, configuration.host, () => {
    console.log(`移动识别服务已启动：http://${configuration.host}:${configuration.port}`);
  });
}
