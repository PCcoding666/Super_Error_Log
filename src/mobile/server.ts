import { loadMobileConfiguration } from './configuration.js';
import { createMobileApp } from './router.js';
import { BailianMobileVision } from './vision.js';

const configuration = loadMobileConfiguration();
const app = await createMobileApp({ dataDir: configuration.dataDir, pairingToken: configuration.pairingToken, vision: new BailianMobileVision(configuration.vision) });
app.listen(configuration.port, configuration.host, () => {
  console.log(`移动识别服务已启动：http://${configuration.host}:${configuration.port}`);
});
