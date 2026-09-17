import { loadMobileConfiguration } from './configuration.js';
import { createMobileApp } from './router.js';
import { BailianMobileVision } from './vision.js';

// Task 1（配对核心 + admin Unix socket 入口）只覆盖回环模式主进程装配。
// 云端模式的主进程装配（PairingManager 内嵌、设备令牌鉴权、/v1/pairing/redeem 路由）
// 属于 Task 2 的范围。在此之前云端的 admin 入口由 admin-cli serve 承担。
const configuration = loadMobileConfiguration();
if (configuration.mode === 'cloud') {
  console.error('云端模式主进程尚未接入（Task 2 落地设备令牌鉴权后启用）。当前管理入口请使用 admin-cli serve。');
  process.exit(1);
}
const app = await createMobileApp({ dataDir: configuration.dataDir, pairingToken: configuration.pairingToken, vision: new BailianMobileVision(configuration.vision) });
app.listen(configuration.port, configuration.host, () => {
  console.log(`移动识别服务已启动：http://${configuration.host}:${configuration.port}`);
});
