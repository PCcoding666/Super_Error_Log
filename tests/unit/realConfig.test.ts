import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

it('根 .env 在新进程加载，真实配置缺失不会伪装 mock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-config-'));
  const modulePath = path.resolve('src/config.ts');
  fs.writeFileSync(path.join(dir, '.env'), 'SEL_AI_MODE=bailian\nSEL_AI_MODEL=qwen3.8-27b\n');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('SEL_AI_') || key === 'DASHSCOPE_API_KEY') delete env[key];
  const code = `const {config}=await import(${JSON.stringify(modulePath)}); console.log(JSON.stringify({mode:config.aiMode,model:config.aiModel}));`;
  const result = execFileSync(process.execPath, ['--import', path.resolve('node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', code], { cwd: dir, env, encoding: 'utf8' });
  expect(JSON.parse(result)).toEqual({ mode: 'bailian', model: 'qwen3.8-27b' });
});
