import { defineConfig } from '@playwright/test';

// E2E 只访问 localhost；本机代理变量会导致健康检查走代理返回 502，统一移除
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NODE_USE_ENV_PROXY']) {
  delete process.env[k];
}

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3199',
    viewport: { width: 390, height: 844 },
  },
  globalSetup: './tests/e2e/globalSetup.ts',
  webServer: [
    {
      command: 'npx tsx src/server.ts',
      url: 'http://localhost:3199/api/health',
      env: { PORT: '3199', SEL_DATA_DIR: 'data-e2e', SEL_AI_MODE: 'mock' },
      reuseExistingServer: false,
      timeout: 120000,
    },
    {
      // 学生网页版（/s/）的合成云端服务器：真实装配 + 合成识别 + mock 语音转写；数据在系统临时目录，退出即删。
      command: 'npx tsx tests/e2e/webClientServer.ts',
      url: 'http://127.0.0.1:3196/s/manifest.webmanifest',
      env: { SEL_WEB_E2E_PORT: '3196', SEL_WEB_E2E_CONTROL_PORT: '3197', SEL_AI_MODE: 'mock' },
      reuseExistingServer: false,
      timeout: 120000,
    },
  ],
});
