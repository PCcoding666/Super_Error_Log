import fs from 'node:fs';
import path from 'node:path';
import { resolvePairingUrl, type CloudUrl } from './pairing.js';

const BEIJING_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

export interface MobileConfiguration {
  host: '127.0.0.1';
  port: number;
  dataDir: string;
  /** loopback：现有本地共享令牌模式；cloud：广州云端模式（Task 2 起接入设备令牌鉴权）。 */
  mode: 'loopback' | 'cloud';
  pairingToken: string;
  /** 配对二维码里发给手机的入口（SEL_MOBILE_PAIRING_URL；缺省 IP 直连，域名仍可选）。未给出时按缺省处理。 */
  pairingUrl?: CloudUrl;
  vision: { baseUrl: string; apiKey: string; timeoutMs: number; bailianOnly: true; models: { inventory: string; transcribe: string; verify: string; ground: string } };
}

export function loadMobileConfiguration(root = process.cwd()): MobileConfiguration {
  const envPath = path.join(root, '.env'); if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
  const mode = process.env.SEL_MOBILE_MODE === 'cloud' ? 'cloud' : process.env.SEL_MOBILE_MODE === 'loopback' ? 'loopback'
    : process.env.SEL_MOBILE_MODE ? (() => { throw new Error(`SEL_MOBILE_MODE 只能是 loopback 或 cloud，收到：${process.env.SEL_MOBILE_MODE}`); })() : 'loopback';
  const aiMode = process.env.SEL_MOBILE_AI_MODE ?? process.env.SEL_AI_MODE;
  if (aiMode !== 'bailian') throw new Error('移动识别要求 SEL_MOBILE_AI_MODE 或 SEL_AI_MODE=bailian，禁止 Mock 降级');
  const baseUrl = process.env.SEL_MOBILE_AI_BASE_URL ?? process.env.SEL_AI_BASE_URL ?? '';
  if (baseUrl.replace(/\/$/, '') !== BEIJING_ENDPOINT) throw new Error(`移动识别只允许百炼北京接口 ${BEIJING_ENDPOINT}`);
  const apiKey = process.env.SEL_MOBILE_AI_API_KEY || process.env.SEL_AI_API_KEY || process.env.DASHSCOPE_API_KEY || '';
  if (!apiKey.trim()) throw new Error('移动识别缺少百炼密钥');
  const commonModel = process.env.SEL_MOBILE_AI_MODEL || process.env.SEL_AI_MODEL || '';
  const model = (stage: string) => process.env[`SEL_MOBILE_AI_MODEL_${stage}`] || commonModel;
  const models = { inventory: model('INVENTORY'), transcribe: model('TRANSCRIBE'), verify: model('VERIFY'), ground: model('GROUND') };
  if (Object.values(models).some(value => !value.trim())) throw new Error('移动识别缺少一个或多个阶段模型配置');
  const pairingToken = process.env.SEL_MOBILE_PAIRING_TOKEN ?? '';
  if (mode === 'loopback' && pairingToken.length < 16) throw new Error('回环模式需要至少16个字符的 SEL_MOBILE_PAIRING_TOKEN；云端模式改用设备令牌，不使用共享令牌');
  const timeoutMs = Number(process.env.SEL_MOBILE_AI_TIMEOUT_MS ?? 1_800_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('SEL_MOBILE_AI_TIMEOUT_MS 必须是正整数毫秒');
  const port = Number(process.env.SEL_MOBILE_PORT ?? 3101);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('SEL_MOBILE_PORT 不合法');
  const host = process.env.SEL_MOBILE_HOST ?? '127.0.0.1'; if (host !== '127.0.0.1') throw new Error('移动识别本轮只允许监听 127.0.0.1');
  const pairingUrl = resolvePairingUrl(process.env.SEL_MOBILE_PAIRING_URL);
  return { host, port, dataDir: path.resolve(root, process.env.SEL_MOBILE_DATA_DIR ?? 'data/mobile-recognition'), mode, pairingToken, pairingUrl,
    vision: { baseUrl: BEIJING_ENDPOINT, apiKey, timeoutMs, bailianOnly: true, models } };
}
