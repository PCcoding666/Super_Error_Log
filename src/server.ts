import { createApp } from './app.js';
import { config } from './config.js';
import { getDb } from './db/connection.js';

getDb();
const app = createApp();
app.listen(config.port, config.host, () => {
  const degraded = config.aiModeDegraded ? '（缺少配置，已降级）' : '';
  console.log(`Super Error Log 已启动：http://${config.host}:${config.port}  [AI 模式: ${config.aiMode}${degraded}]`);
});
