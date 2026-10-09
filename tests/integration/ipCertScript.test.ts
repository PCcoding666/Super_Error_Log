import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// deploy/generate-ip-cert.sh：IP 直连入口自签证书生成脚本（服务器上以 root 运行）。
// 测试在临时目录里生成一次性证书和私钥，用后删除；不接触任何服务器。
const script = path.resolve('deploy/generate-ip-cert.sh');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-ip-cert-')); roots.push(root);
  return root;
}

// 当前用户的主组：测试里代替服务器上的 caddy 组（chgrp 到自己所在的组无需特权）。
const ownGroup = execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim();
const run = (args: string[]) => spawnSync('/bin/bash', [script, ...args], { encoding: 'utf8', timeout: 30_000 });

describe('deploy/generate-ip-cert.sh', () => {
  it('生成 SAN 只含该 IP 的 P-256 自签证书，私钥 0640、目录 0750、组为指定组，输出不含私钥', () => {
    const dir = path.join(tempRoot(), 'tls-ip');
    const result = run(['--ip', '8.163.96.197', '--dir', dir, '--group', ownGroup]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toMatch(/PRIVATE KEY/);
    expect(fs.readdirSync(dir).sort()).toEqual(['cert.pem', 'key.pem']);

    const certPem = fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8');
    const keyPem = fs.readFileSync(path.join(dir, 'key.pem'), 'utf8');
    const cert = new crypto.X509Certificate(certPem);
    expect(cert.subjectAltName).toBe('IP Address:8.163.96.197');
    expect(cert.ca).toBe(false);
    expect(cert.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']); // EKU serverAuth
    expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    // 曲线按名称编码（OID prime256v1）：显式曲线参数的证书 Caddy 加载不了。
    expect(cert.raw.includes(Buffer.from('06082a8648ce3d030107', 'hex'))).toBe(true);
    expect(cert.checkPrivateKey(crypto.createPrivateKey(keyPem))).toBe(true);
    expect(cert.verify(cert.publicKey)).toBe(true); // 自签
    const days = (Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / 86_400_000;
    expect(days).toBe(730);
    // 输出给出可核对的 SHA-256 指纹（与 App 内固定的证书比对用）。
    expect(result.stdout).toContain(cert.fingerprint256);

    const gid = fs.statSync(dir).gid;
    expect(fs.statSync(dir).mode & 0o777).toBe(0o750);
    expect(fs.statSync(path.join(dir, 'key.pem')).mode & 0o777).toBe(0o640);
    expect(fs.statSync(path.join(dir, 'key.pem')).gid).toBe(gid);
    expect(fs.statSync(path.join(dir, 'cert.pem')).mode & 0o777).toBe(0o644);
    expect(gid).toBe(process.getgid?.());
  });

  it('目标目录已存在（即使为空）或为符号链接时拒绝，不改动原有内容', () => {
    const root = tempRoot();
    const existing = path.join(root, 'existing');
    fs.mkdirSync(existing, { mode: 0o755 }); fs.chmodSync(existing, 0o755);
    const empty = run(['--ip', '8.163.96.197', '--dir', existing, '--group', ownGroup]);
    expect(empty.status).not.toBe(0);
    expect(fs.readdirSync(existing)).toEqual([]);
    expect(fs.statSync(existing).mode & 0o777).toBe(0o755);

    fs.writeFileSync(path.join(existing, 'cert.pem'), 'previous-certificate');
    const filled = run(['--ip', '8.163.96.197', '--dir', existing, '--group', ownGroup]);
    expect(filled.status).not.toBe(0);
    expect(fs.readFileSync(path.join(existing, 'cert.pem'), 'utf8')).toBe('previous-certificate');

    const link = path.join(root, 'link');
    fs.symlinkSync(path.join(root, 'nowhere'), link);
    const linked = run(['--ip', '8.163.96.197', '--dir', link, '--group', ownGroup]);
    expect(linked.status).not.toBe(0);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(root, 'nowhere'))).toBe(false);
  });

  it('拒绝非 IPv4、相对路径与缺参数；中途失败时删除本次新建的目录', () => {
    const root = tempRoot();
    for (const ip of ['study.pccoding666.com', '8.163.96.256', '08.163.96.197', '8.163.96', '::1']) {
      const result = run(['--ip', ip, '--dir', path.join(root, 'bad-ip'), '--group', ownGroup]);
      expect(result.status, ip).not.toBe(0);
    }
    expect(run(['--ip', '8.163.96.197', '--dir', 'relative/tls-ip', '--group', ownGroup]).status).not.toBe(0);
    expect(run(['--ip', '8.163.96.197', '--dir', path.join(root, 'no-group')]).status).not.toBe(0);
    expect(fs.readdirSync(root)).toEqual([]);

    // chgrp 失败发生在私钥写出之后：目录连同私钥一起删除，不留半成品。
    const failed = run(['--ip', '8.163.96.197', '--dir', path.join(root, 'tls-ip'), '--group', 'sel-no-such-group-for-test']);
    expect(failed.status).not.toBe(0);
    expect(fs.existsSync(path.join(root, 'tls-ip'))).toBe(false);
  });
});
