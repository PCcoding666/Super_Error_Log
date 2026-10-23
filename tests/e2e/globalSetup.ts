import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { generateFixtures, MANIFEST_PATH } from '../../src/fixtures/generate.js';

/** E2E 全局准备：确保夹具存在、清空 e2e 数据目录（确定性起点）。 */
export default async function globalSetup(): Promise<void> {
  if (!fs.existsSync(MANIFEST_PATH)) {
    await generateFixtures();
  }
  fs.rmSync(path.resolve('data-e2e'), { recursive: true, force: true });
  // 学生端单页应用由夹具服务器从 dist/client 下发：没构建过就先构建一次（CI 里 npm run build 已经做了）。
  if (!fs.existsSync(path.resolve('dist/client/index.html'))) execFileSync('npm', ['run', 'client:build'], { stdio: 'inherit' });
}
