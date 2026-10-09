import http from 'node:http';
import path from 'node:path';
import { createAdminServer, type AdminServerHandle } from './adminServer.js';
import { DEFAULT_WEB_PAIRING_BASE, PairingManager, resolvePairingUrl, webPairingLink, type PairingCodePayload } from './pairing.js';

/**
 * 管理员 CLI 客户端：仅在本机通过 dataDir/admin.sock 与管理入口通信。
 * 用法（SSH 到服务器后执行）：
 *   node dist/mobile/admin-cli.js --data-dir /var/lib/super-error-log pairing-code
 *   node dist/mobile/admin-cli.js --data-dir /var/lib/super-error-log devices
 *   node dist/mobile/admin-cli.js --data-dir /var/lib/super-error-log revoke <deviceId>
 * 不读取任何密钥；输出不含长期令牌。
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface AdminCliOptions { dataDir: string; command: string; argument?: string; webBase: string }

function parseArguments(argv: string[]): AdminCliOptions {
  const [node, script, ...rest] = argv;
  void node; void script;
  let dataDir = '';
  let command = '';
  let argument: string | undefined;
  let webBase = DEFAULT_WEB_PAIRING_BASE;
  for (let index = 0; index < rest.length; index += 1) {
    const value: string | undefined = rest[index];
    if (value === undefined) continue;
    if (value === '--data-dir') {
      dataDir = rest[index + 1] ?? '';
      index += 1;
    } else if (value === '--web-base') {
      webBase = rest[index + 1] ?? '';
      index += 1;
    } else if (value === '--help' || value === '-h') {
      command = 'help';
    } else if (!command && value !== '') {
      command = value;
    } else if (command && command !== 'help' && argument === undefined && value !== '') {
      argument = value;
    }
  }
  return { dataDir, command, argument, webBase };
}

function usage(): string {
  return [
    '用法：admin-cli --data-dir <数据目录> <命令> [参数]',
    '',
    '命令：',
    '  pairing-code            生成新的配对二维码载荷（5 分钟有效，单次使用），并给出学生网页版的配对链接',
    '  devices                 列出已配对设备（不含令牌）',
    '  revoke <deviceId>       撤销指定设备的访问令牌',
    '  serve                   以独立进程启动管理入口（通常由主服务进程内嵌启动）',
    '',
    '选项：',
    `  --web-base <https 地址>  网页版配对链接用的入口（缺省 ${DEFAULT_WEB_PAIRING_BASE}；必须是手机 Safari 信任的 HTTPS 主机名）`,
    '',
    '示例：',
    '  node dist/mobile/admin-cli.js --data-dir /var/lib/super-error-log pairing-code',
  ].join('\n');
}

function requestOverSocket(socketPath: string, method: string, url: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, method, path: url, headers: { accept: 'application/json' } }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text: raw }));
    });
    request.on('error', reject);
    request.setTimeout(30_000, () => request.destroy(new Error('管理入口连接超时。')));
    request.end();
  });
}

async function main(): Promise<void> {
  const { dataDir, command, argument, webBase } = parseArguments(process.argv);
  if (command === 'help' || !command) { process.stdout.write(`${usage()}\n`); process.exit(command === 'help' ? 0 : 1); }
  if (!dataDir || !path.isAbsolute(dataDir)) { process.stderr.write('必须提供绝对路径的 --data-dir。\n'); process.exit(1); }
  const socketPath = path.join(dataDir, 'admin.sock');
  try {
    if (command === 'serve') {
      const manager = await PairingManager.open(dataDir, { pairingUrl: resolvePairingUrl(process.env.SEL_MOBILE_PAIRING_URL) });
      const handle: AdminServerHandle = await createAdminServer(manager);
      process.stdout.write(`管理入口已监听：${handle.socketPath}\n`);
      const shutdown = async (): Promise<void> => {
        try { await handle.close(); } finally { process.exit(0); }
      };
      process.once('SIGINT', () => void shutdown());
      process.once('SIGTERM', () => void shutdown());
      return;
    }
    if (command === 'pairing-code') {
      if (!/^https:\/\/[^/?#\s]+$/.test(webBase.replace(/\/$/, ''))) { process.stderr.write('--web-base 必须是 https://主机名 形式。\n'); process.exit(1); }
      const { status, text } = await requestOverSocket(socketPath, 'GET', '/pairing-code');
      if (status !== 200) { process.stderr.write(`生成配对码失败（HTTP ${status}）：${text}\n`); process.exit(1); }
      const body = JSON.parse(text) as { payload: PairingCodePayload; expiresAt: string };
      process.stdout.write(`${JSON.stringify(body.payload, null, 2)}\n`);
      process.stdout.write(`有效期至：${body.expiresAt}\n`);
      // 同一个配对会话：App 扫上面的 JSON 二维码；网页版用这条链接（发给学生，或做成二维码让手机相机扫）。二选一，单次使用。
      process.stdout.write(`网页版配对链接（用 Safari 打开；与上面的二维码二选一）：\n${webPairingLink(body.payload, webBase)}\n`);
      return;
    }
    if (command === 'devices') {
      const { status, text } = await requestOverSocket(socketPath, 'GET', '/devices');
      if (status !== 200) { process.stderr.write(`读取设备列表失败（HTTP ${status}）：${text}\n`); process.exit(1); }
      const body = JSON.parse(text) as { devices: Array<{ deviceId: string; deviceInfo: string; revoked: boolean; expiresAt: string }> };
      if (body.devices.length === 0) { process.stdout.write('尚无已配对设备。\n'); return; }
      for (const device of body.devices) {
        const state = device.revoked ? '已撤销' : '有效';
        process.stdout.write(`${device.deviceId}  ${state}  到期 ${device.expiresAt}  ${device.deviceInfo}\n`);
      }
      return;
    }
    if (command === 'revoke') {
      if (!argument || !UUID.test(argument)) { process.stderr.write('revoke 需要一个合法的设备 UUID。\n'); process.exit(1); }
      const { status, text } = await requestOverSocket(socketPath, 'POST', `/devices/${argument}/revoke`);
      if (status !== 200) { process.stderr.write(`撤销失败（HTTP ${status}）：${text}\n`); process.exit(1); }
      process.stdout.write(`已撤销设备 ${argument}。\n`);
      return;
    }
    process.stderr.write(`未知命令：${command}\n\n${usage()}\n`);
    process.exit(1);
  } catch (error) {
    process.stderr.write(`管理入口不可用（${socketPath}）：${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

void main();
