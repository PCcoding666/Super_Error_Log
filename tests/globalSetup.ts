import fs from 'node:fs';
import { generateFixtures, MANIFEST_PATH } from '../src/fixtures/generate.js';

/** fixture 不存在时生成一次（幂等） */
export default async function globalSetup(): Promise<void> {
  if (!fs.existsSync(MANIFEST_PATH)) {
    await generateFixtures();
  }
}
