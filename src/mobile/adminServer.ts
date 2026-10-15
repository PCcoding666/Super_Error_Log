import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import { PairingError, type PairingManager } from './pairing.js';

export interface AdminServerHandle {
  server: http.Server;
  socketPath: string;
  close(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 仅本机管理员可用的管理入口：监听 dataDir/admin.sock（父目录 0700、socket 0600），
 * 与公网 app 同进程但相互独立。公网 app 不暴露任何管理路由。
 */
export async function createAdminServer(manager: PairingManager): Promise<AdminServerHandle> {
  const dataDir = path.resolve(manager.dataDir);
  const socketPath = path.join(dataDir, 'admin.sock');
  // 已存在的 socket 说明另一实例在运行或上次未清理；不静默覆盖。
  const stale = fs.existsSync(socketPath);
  if (stale) {
    // 探测是否仍有存活监听者：连接失败才视为残留文件。
    const alive = await canConnect(socketPath);
    if (alive) throw new Error(`管理 socket 已被占用：${socketPath}`);
    fs.rmSync(socketPath, { force: true });
  }
  fs.mkdirSync(dataDir, { recursive: true });
  await fs.promises.chmod(dataDir, 0o700);

  const app = express();
  app.disable('x-powered-by');
  app.use((_request, response, next) => { response.setHeader('cache-control', 'private, no-store'); next(); });

  app.get('/pairing-code', (_request, response) => {
    const { payload, expiresAt } = manager.createSession();
    response.json({ payload, expiresAt: expiresAt.toISOString() });
  });
  app.get('/devices', async (_request, response, next) => {
    try { response.json({ devices: await manager.listDevices() }); } catch (error) { next(error); }
  });
  app.post('/devices/:id/revoke', async (request, response, next) => {
    try {
      const deviceId = request.params.id;
      if (!UUID.test(deviceId)) { response.status(400).json({ error: { code: 'invalid_request', message: '设备标识必须是 UUID。' } }); return; }
      await manager.revoke(deviceId);
      response.json({ ok: true });
    } catch (error) { next(error); }
  });
  app.use((_request, response) => response.status(404).json({ error: { code: 'not_found', message: '管理接口不存在。' } }));
  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (response.headersSent) return;
    if (error instanceof PairingError) {
      const status = error.code === 'pairing_not_found' ? 404 : error.code === 'invalid_pairing_payload' ? 400 : 503;
      response.status(status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    response.status(500).json({ error: { code: 'internal', message: '管理入口暂时无法完成请求。' } });
  };
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.off('error', reject); resolve(); });
  });
  await fs.promises.chmod(socketPath, 0o600);

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.close(() => { server.off('error', reject); resolve(); });
    });
    await fs.promises.rm(socketPath, { force: true });
  };
  return { server, socketPath, close };
}

async function canConnect(socketPath: string): Promise<boolean> {
  const net = await import('node:net');
  return new Promise(resolve => {
    const probe = net.createConnection({ path: socketPath });
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
    probe.setTimeout(1_000, () => { probe.destroy(); resolve(true); });
  });
}
