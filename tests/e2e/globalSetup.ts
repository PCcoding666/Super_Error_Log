import fs from 'node:fs';
import path from 'node:path';
import { generateFixtures, MANIFEST_PATH } from '../../src/fixtures/generate.js';

/** E2E 全局准备：确保夹具存在、清空 e2e 数据目录（确定性起点）。 */
export default async function globalSetup(): Promise<void> {
  if (!fs.existsSync(MANIFEST_PATH)) {
    await generateFixtures();
  }
  fs.rmSync(path.resolve('data-e2e'), { recursive: true, force: true });
}
