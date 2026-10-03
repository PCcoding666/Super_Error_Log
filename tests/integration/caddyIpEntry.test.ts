import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLOUD_URLS, DEFAULT_PAIRING_URL } from '../../src/mobile/pairing.js';

// IP 直连入口（deploy/caddy/Caddyfile）。
// 静态部分总是运行；真实 Caddy 部分需要本机 Caddy 二进制：SEL_CADDY_BIN=/path/to/caddy（与生产同为 v2.10.x）。
// 真实部分只在本机回环上运行：证书和私钥临时生成、用后删除；域名站点的 ACME 签发换成本地临时证书，
// 不向任何证书机构或生产服务器发请求。
const caddyfile = fs.readFileSync('deploy/caddy/Caddyfile', 'utf8');
const IP = new URL(DEFAULT_PAIRING_URL).hostname;
const DOMAIN = new URL(CLOUD_URLS.find(url => url !== DEFAULT_PAIRING_URL)!).hostname;

/** 取顶层站点块（站点地址行到同缩进的右括号），去掉注释与空行。 */
function siteBlock(address: string): string[] {
  const lines = caddyfile.split('\n');
  const start = lines.indexOf(`${address} {`);
  if (start < 0) throw new Error(`Caddyfile 缺少站点 ${address}`);
  const end = lines.indexOf('}', start);
  return lines.slice(start + 1, end).map(line => line.trimEnd()).filter(line => line.trim() !== '' && !line.trim().startsWith('#'));
}

describe('Caddyfile IP 直连入口（静态）', () => {
  it('全局 default_sni 为公网 IP；IP 站点用服务器上生成的自签证书；域名站点仍走 ACME', () => {
    const global = caddyfile.slice(caddyfile.indexOf('{\n'), caddyfile.indexOf('\n}\n') + 1);
    expect(global).toContain(`\tdefault_sni ${IP}\n`);
    const ipSite = siteBlock(`https://${IP}`);
    expect(ipSite[0]).toBe('\ttls /etc/super-error-log/tls-ip/cert.pem /etc/super-error-log/tls-ip/key.pem');
    const domainSite = siteBlock(DOMAIN);
    expect(domainSite.slice(0, 5)).toEqual(['\ttls {', '\t\tissuer acme {', '\t\t\tdisable_http_challenge', '\t\t}', '\t}']);
  });

  it('两个入口的请求体上限与反向代理完全一致', () => {
    const upstream = (lines: string[]) => lines.slice(lines.findIndex(line => line === '\trequest_body {'));
    const ipUpstream = upstream(siteBlock(`https://${IP}`));
    expect(ipUpstream.length).toBeGreaterThan(5);
    expect(ipUpstream).toEqual(upstream(siteBlock(DOMAIN)));
  });

  it('Caddyfile、服务端二维码地址与 App 白名单里的 IP 和域名一致', () => {
    expect(CLOUD_URLS).toEqual([`https://${IP}`, `https://${DOMAIN}`]);
    const swift = fs.readFileSync('iOS/StudentApp/Domain/CloudPairing.swift', 'utf8');
    expect(swift).toContain(`static let ipHost = "${IP}"`);
    expect(swift).toContain(`static let domainHost = "${DOMAIN}"`);
  });
});

const caddyBin = process.env.SEL_CADDY_BIN;

describe.skipIf(!caddyBin)('Caddyfile IP 直连入口（本机真实 Caddy，SEL_CADDY_BIN）', () => {
  let root = '';
  let ipCertPem = '';
  let domainCertPem = '';
  let upstream: http.Server;
  let upstreamPort = 0;
  const seen: Array<{ host?: string; realIp?: string; url?: string }> = [];
  const caddies: ChildProcess[] = [];

  const freePort = (): Promise<number> => new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as net.AddressInfo; probe.close(() => resolve(port)); });
  });

  /** 把生产 Caddyfile 改成本机可运行：只替换端口、存储、证书路径与上游地址；每处替换必须命中。 */
  function localCaddyfile(port: number, httpPort: number, withDefaultSni: boolean): string {
    const replace = (text: string, from: string, to: string, count: number): string => {
      const hits = text.split(from).length - 1;
      if (hits !== count) throw new Error(`生产 Caddyfile 结构已变（${JSON.stringify(from)} 命中 ${hits} 次，期望 ${count}）`);
      return text.split(from).join(to);
    };
    let text = caddyfile;
    text = replace(text, '\tadmin off\n', `\tadmin off\n\thttps_port ${port}\n\thttp_port ${httpPort}\n\tstorage file_system ${root}/caddy-storage\n\tskip_install_trust\n`, 1);
    text = replace(text, '\ttls {\n\t\tissuer acme {\n\t\t\tdisable_http_challenge\n\t\t}\n\t}', `\ttls ${root}/domain/cert.pem ${root}/domain/key.pem`, 1);
    text = replace(text, '/etc/super-error-log/tls-ip/', `${root}/tls-ip/`, 2);
    text = replace(text, 'reverse_proxy 127.0.0.1:3101 {', `reverse_proxy 127.0.0.1:${upstreamPort} {`, 2);
    if (!withDefaultSni) text = replace(text, `\tdefault_sni ${IP}\n`, '', 1);
    return text;
  }

  async function startCaddy(name: string, withDefaultSni: boolean): Promise<number> {
    const port = await freePort();
    const file = path.join(root, `${name}.Caddyfile`);
    fs.writeFileSync(file, localCaddyfile(port, await freePort(), withDefaultSni));
    const home = path.join(root, `${name}-home`);
    fs.mkdirSync(home);
    const child = spawn(caddyBin!, ['run', '--config', file, '--adapter', 'caddyfile'], {
      env: { PATH: process.env.PATH ?? '', HOME: home, XDG_DATA_HOME: path.join(home, 'data'), XDG_CONFIG_HOME: path.join(home, 'config') },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    caddies.push(child);
    let log = '';
    child.stderr?.on('data', chunk => { log += String(chunk); });
    const closed = new Promise(resolve => child.once('close', resolve));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) { await closed; throw new Error(`Caddy 启动失败：${log}`); }
      const open = await new Promise<boolean>(resolve => {
        const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true); });
        socket.once('error', () => resolve(false));
      });
      if (open) return port;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Caddy 未在 10 秒内监听：${log}`);
  }

  /** TLS 握手：servername 缺省时 Node 不发 SNI（与手机按 IP 连接相同）。 */
  function handshake(port: number, options: { servername?: string; ca: string; identity: string }): Promise<{ fingerprint: string; authorized: boolean }> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: '127.0.0.1', port, ca: [options.ca], ...(options.servername ? { servername: options.servername } : {}),
        checkServerIdentity: (_host, cert) => tls.checkServerIdentity(options.identity, cert),
      }, () => {
        const result = { fingerprint: socket.getPeerCertificate().fingerprint256, authorized: socket.authorized };
        socket.end(); resolve(result);
      });
      socket.once('error', reject);
      socket.setTimeout(5_000, () => socket.destroy(new Error('TLS 握手超时')));
    });
  }

  function get(port: number, host: string, ca: string, servername?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const request = https.request({
        host: '127.0.0.1', port, path: '/v2/health', headers: { host }, ca: [ca], agent: false,
        ...(servername ? { servername } : {}),
        checkServerIdentity: (_host: string, cert: tls.PeerCertificate) => tls.checkServerIdentity(host, cert),
      }, response => { response.resume(); response.on('end', () => resolve(response.statusCode ?? 0)); });
      request.once('error', reject);
      request.setTimeout(5_000, () => request.destroy(new Error('请求超时')));
      request.end();
    });
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-caddy-ip-'));
    // IP 证书用真实部署脚本生成；域名证书是本地临时自签（替代 ACME）。
    const group = execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim();
    execFileSync('/bin/bash', ['deploy/generate-ip-cert.sh', '--ip', IP, '--dir', path.join(root, 'tls-ip'), '--group', group], { stdio: 'pipe' });
    ipCertPem = fs.readFileSync(path.join(root, 'tls-ip/cert.pem'), 'utf8');
    fs.mkdirSync(path.join(root, 'domain'), { mode: 0o700 });
    fs.writeFileSync(path.join(root, 'domain.cnf'), `[req]\ndistinguished_name = dn\nprompt = no\nx509_extensions = v3\n[dn]\nCN = ${DOMAIN}\n[v3]\nsubjectAltName = DNS:${DOMAIN}\n`);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-pkeyopt', 'ec_param_enc:named_curve', '-nodes', '-days', '1',
      '-config', path.join(root, 'domain.cnf'), '-keyout', path.join(root, 'domain/key.pem'), '-out', path.join(root, 'domain/cert.pem')], { stdio: 'pipe' });
    domainCertPem = fs.readFileSync(path.join(root, 'domain/cert.pem'), 'utf8');
    // 合成上游：模拟服务端无令牌 401，记录 Caddy 转发来的 Host 与 X-Real-IP。
    upstream = http.createServer((request, response) => {
      seen.push({ host: request.headers.host, realIp: request.headers['x-real-ip'] as string | undefined, url: request.url });
      response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"code":"unauthorized","message":"设备令牌无效。"}}');
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    for (const child of caddies) child.kill('SIGTERM');
    await Promise.all(caddies.map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))));
    await new Promise(resolve => upstream?.close(resolve));
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('不带 SNI 的握手拿到 IP 自签证书并通过校验，请求转发到上游（无令牌 401）', async () => {
    const port = await startCaddy('with-default-sni', true);
    const ipFingerprint = new crypto.X509Certificate(ipCertPem).fingerprint256;
    const noSni = await handshake(port, { ca: ipCertPem, identity: IP });
    expect(noSni).toEqual({ fingerprint: ipFingerprint, authorized: true });

    seen.length = 0;
    expect(await get(port, IP, ipCertPem)).toBe(401);
    expect(seen).toEqual([{ host: IP, realIp: '127.0.0.1', url: '/v2/health' }]);

    // 域名 SNI 仍拿到域名证书、仍转发到同一上游：域名入口行为不变。
    const domain = await handshake(port, { servername: DOMAIN, ca: domainCertPem, identity: DOMAIN });
    expect(domain).toEqual({ fingerprint: new crypto.X509Certificate(domainCertPem).fingerprint256, authorized: true });
    seen.length = 0;
    expect(await get(port, DOMAIN, domainCertPem, DOMAIN)).toBe(401);
    expect(seen).toEqual([{ host: DOMAIN, realIp: '127.0.0.1', url: '/v2/health' }]);
  });

  it('对照：去掉 default_sni 后不带 SNI 的握手被 Caddy 以 TLS 告警拒绝（复现网卡 IP 与公网 IP 不同时的问题）', async () => {
    const port = await startCaddy('without-default-sni', false);
    // 握手到达了 Caddy，但它找不到证书，回 internal_error 告警（不是连不上）。
    await expect(handshake(port, { ca: ipCertPem, identity: IP })).rejects.toMatchObject({ code: 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR' });
    // 同一配置下，显式以 IP 作 SNI（Node 会忽略 IP 形式的 servername，改用 openssl s_client）能拿到 IP 证书：
    // 说明差别只在「无 SNI」这一条路径上，default_sni 补的正是它。
    const probe = spawnSync('openssl', ['s_client', '-connect', `127.0.0.1:${port}`, '-servername', IP], { input: '', encoding: 'utf8', timeout: 10_000 });
    const served = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(probe.stdout)?.[0];
    expect(served, probe.stderr).toBeDefined();
    expect(new crypto.X509Certificate(served!).fingerprint256).toBe(new crypto.X509Certificate(ipCertPem).fingerprint256);
  });
});
