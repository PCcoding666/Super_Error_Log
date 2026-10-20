import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { assembleCloudService, type CloudAssembly } from '../../src/mobile/cloudAssembly.js';
import { AdminAuth } from '../../src/admin/auth.js';
let root: string; let service: CloudAssembly | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-admin-assembly-')); vi.stubEnv('SEL_STUDENT_HOST_DIR', path.join(root, 'host')); });
afterEach(async () => { await service?.close(); service = undefined; vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
async function start(): Promise<string> {
  service = await assembleCloudService({ mode: 'cloud', host: '127.0.0.1', port: 0, dataDir: root, pairingToken: '',
    vision: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'synthetic', timeoutMs: 1000, bailianOnly: true,
      models: { inventory: 'm', transcribe: 'm', verify: 'm', ground: 'm' } } });
  await service.listen(); return `http://127.0.0.1:${service.boundPort()}`;
}
it('mounts the authenticated admin dashboard in the production student-host assembly with Secure cookies', async () => {
  vi.stubEnv('SEL_STUDENT_HOST_ENABLED', '1');
  const base = await start();
  expect((await fetch(`${base}/admin/login`)).status).toBe(200);
  const auth = AdminAuth.open(path.join(root, 'host')); const password = auth.rotatePassword(); auth.close();
  const login = await fetch(`${base}/admin/login`, { method: 'POST', redirect: 'manual', headers: {
    origin: base.replace('http:', 'https:'), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }) });
  expect(login.status).toBe(303); expect(login.headers.get('set-cookie')).toContain('; Secure');
  const page = await fetch(`${base}/admin/`, { redirect: 'manual', headers: { cookie: login.headers.get('set-cookie')!.split(';')[0]! } });
  expect(page.status).toBe(200); expect(await page.text()).toContain('用量与性能');
  expect((await fetch(`${base}/v2/health`)).status).toBe(401);
});
it('keeps admin absent when the invitation host is off, including student workers', async () => {
  vi.stubEnv('SEL_STUDENT_HOST_ENABLED', '0'); vi.stubEnv('SEL_STUDENT_WORKER', '1');
  const base = await start(); expect((await fetch(`${base}/admin/login`)).status).toBe(404);
  expect(fs.existsSync(path.join(root, 'host', 'admin.db'))).toBe(false);
});
