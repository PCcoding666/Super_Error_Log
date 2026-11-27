// 本地 HTTPS 反向代理：模拟生产 Caddy（TLS 终止 + 透传到 127.0.0.1:UPSTREAM），让网关的 https Origin 校验和线上一致。
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname);
const listen = Number(process.env.PROXY_PORT ?? 3443);
const upstream = Number(process.env.UPSTREAM_PORT ?? 3177);
const server = https.createServer({ key: fs.readFileSync(path.join(here, 'tls/key.pem')), cert: fs.readFileSync(path.join(here, 'tls/cert.pem')) }, (req, res) => {
  const headers = { ...req.headers, 'x-real-ip': req.socket.remoteAddress ?? '127.0.0.1', 'x-forwarded-for': req.socket.remoteAddress ?? '127.0.0.1', 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host ?? '' };
  const started = Date.now();
  const up = http.request({ host: '127.0.0.1', port: upstream, method: req.method, path: req.url, headers }, upRes => {
    res.writeHead(upRes.statusCode ?? 502, upRes.headers);
    upRes.pipe(res);
    upRes.on('end', () => { if (!/\/s\/app\/assets\//.test(req.url ?? '')) console.log(JSON.stringify({ t: new Date().toISOString(), m: req.method, u: req.url, s: upRes.statusCode, ms: Date.now() - started, rid: upRes.headers['x-sel-request-id'] })); });
  });
  up.on('error', err => { console.error('upstream error', req.method, req.url, err.message); if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); res.end('proxy: upstream error'); });
  req.pipe(up);
});
server.keepAliveTimeout = 65_000;
server.listen(listen, '127.0.0.1', () => console.log(`tls-proxy https://127.0.0.1:${listen} -> http://127.0.0.1:${upstream}`));
