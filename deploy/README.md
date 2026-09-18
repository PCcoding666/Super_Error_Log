# 云端部署手册（广州 ECS 239 · cgroup v1 · study.pccoding666.com）

发布包由 `npm run release:build` 产出（白名单打包，详见 `scripts/release-whitelist.txt`）。
包内只有运行必需物：`dist/`、`package.json`、`package-lock.json`、`.env.example`、`deploy/`——
不含源代码、测试、照片、密钥、Git 历史。

## 0. 前置条件

- 服务器：广州 ECS（systemd 239，cgroup v1）。实测机型：**Alibaba Cloud Linux 3（Anolis 8，RHEL8 系）**——以下命令按此环境验证（2026-09-18 实际部署）。
- Caddy **>= 2.10**（`request_body` 指令 v2.10.0 起支持，标记实验性；`caddy version` 确认）。ECS 直连 GitHub 慢，可用镜像加速（如 ghfast.top 前缀）后 `setcap`。
- Node 24 LTS：下载 linux-x64 官方二进制，解压到 `/opt/super-error-log/node-v24/`（受控发布目录，不用发行版 `/usr/bin/node`）。国内可用 `https://mirrors.aliyun.com/nodejs-release/<版本>/`。
- 80/443 已由 Caddy（443）与原网站（80）分占；**不动原网站**。
- DNS：`study.pccoding666.com` A 记录必须指向本机公网 IP（TLS-ALPN-01 质询前置条件，签发前先 `getent hosts` 验证）。

## 1. 创建专用用户与目录（一次性）

```bash
# 无登录、无家目录的系统用户
useradd --system --no-create-home --shell /usr/sbin/nologin supererrorlog

# 发布目录（root 持有，服务只读）
mkdir -p /opt/super-error-log/releases
# Node 24 解压后放这里：
#   /opt/super-error-log/node-v24/bin/node

# 数据目录（专用用户私有，0750——caddy 需要进入其子目录，不能 0700！见 §4 说明）
install -d -o supererrorlog -g supererrorlog -m 0750 /var/lib/super-error-log

# Caddy ACME 存储目录（caddy 用户可写；证书私钥落这里，见 §4）
useradd --system --no-create-home --shell /usr/sbin/nologin caddy 2>/dev/null || true
install -d -o caddy -g caddy -m 0700 /var/lib/super-error-log/caddy
# caddy 需要能穿越数据目录父级到达自己的子目录：
usermod -aG supererrorlog caddy

# 环境变量文件（0600 root:root，内容见 §2）
install -d -m 0755 /etc/super-error-log
touch /etc/super-error-log/env && chmod 0600 /etc/super-error-log/env
```

## 2. 环境变量（/etc/super-error-log/env）

只放密钥与模式开关；格式 `KEY=value`，无引号：

```
SEL_MOBILE_MODE=cloud
SEL_MOBILE_PORT=3101
SEL_MOBILE_HOST=127.0.0.1
SEL_MOBILE_DATA_DIR=/var/lib/super-error-log
SEL_MOBILE_AI_MODE=bailian
SEL_MOBILE_AI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
SEL_MOBILE_AI_API_KEY=<百炼密钥>
SEL_MOBILE_AI_MODEL=<模型名>
SEL_MOBILE_AI_MODEL_INVENTORY=<模型名>
SEL_MOBILE_AI_MODEL_TRANSCRIBE=<模型名>
SEL_MOBILE_AI_MODEL_VERIFY=<模型名>
SEL_MOBILE_AI_MODEL_GROUND=<模型名>
SEL_MOBILE_AI_TIMEOUT_MS=1800000
```

参考 `.env.example`；缺任何必填项服务启动会直接失败（fail-hard，不静默降级 mock）。
`SEL_MOBILE_HOST` 只允许 `127.0.0.1`——公网入口只有 Caddy。

## 3. 发布新版本

```bash
# 本地产包（macOS）
npm run release:build          # → super-error-log-<version>.tar.gz

# 上传
scp super-error-log-<version>.tar.gz root@<ECS>:/opt/super-error-log/

# 服务器：解到受控发布目录
cd /opt/super-error-log
tar -xzf super-error-log-<version>.tar.gz -C releases/
mv releases/super-error-log releases/<version>   # 或 git tag 版号

# Linux 生产依赖：在受控发布目录内 npm ci --omit=dev
# 绝不从 macOS 复制 node_modules（sharp 等原生模块是平台相关的）！
cd releases/<version>
/opt/super-error-log/node-v24/bin/npm ci --omit=dev

# 切软链 + 重启（见 §4）
ln -sfn /opt/super-error-log/releases/<version> /opt/super-error-log/current
systemctl restart super-error-log
```

## 4. systemd 与 Caddy 安装

```bash
# systemd 单元（错题本服务）
cp /opt/super-error-log/current/deploy/systemd/super-error-log.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now super-error-log

# Caddy：一个单独的 systemd 服务（super-error-log-caddy），跑本包的 Caddyfile；
# 不并入、不改动原网站的任何 Caddy/HTTP 服务。80 端口仍归原网站——本服务只要 443。
# 注意：Caddyfile 里 admin off + auto_https disable_redirects，改配置=重启本服务。
caddy validate --config /opt/super-error-log/current/deploy/caddy/Caddyfile
cat >/etc/systemd/system/super-error-log-caddy.service <<'EOF'
[Unit]
Description=Caddy 443 entry for study.pccoding666.com (Super Error Log)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/caddy run --config /opt/super-error-log/current/deploy/caddy/Caddyfile
# Caddyfile 里 admin off：caddy reload 走 admin API 不可用，改配置一律 restart 本服务。
Restart=on-failure
RestartSec=5s
# 443 绑定能力：setcap 文件能力会被 NoNewPrivileges 抑制（实测踩坑），
# 必须由 systemd 在 exec 前注入环境能力——两行同时存在才生效：
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
# ACME 证书存储必须显式指定可写目录（caddy 用户无家目录时 XDG 路径不可用）。
# 注意父目录 /var/lib/super-error-log 须为 0750 且 caddy 属 supererrorlog 组，
# 否则 caddy 无法穿越到自己的子目录（实测踩坑：open key: permission denied）。
Environment=XDG_DATA_HOME=/var/lib/super-error-log/caddy
ReadWritePaths=/var/lib/super-error-log/caddy
User=caddy
Group=caddy

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now super-error-log-caddy
```

> 若机器上已有一套 Caddy 管理方式（如 systemd 包安装），可把本服务并入既有单元——
> 但**不要**动 `wikiworldlife-board` 或原网站的 80 端口配置。

## 5. 部署验收（服务器实测，直接读内核接口）

```bash
# cgroup v1 实测（systemctl show 不是内核读回）：
cat /sys/fs/cgroup/memory/system.slice/super-error-log.service/memory.limit_in_bytes   # 期望 1073741824
cat /sys/fs/cgroup/cpu/system.slice/super-error-log.service/cpu.cfs_quota_us          # 期望 150000（150% × 100000 period）
cat /sys/fs/cgroup/cpu/system.slice/super-error-log.service/cpu.cfs_period_us          # 期望 100000

# 监听端口：服务只应 127.0.0.1:3101 + admin socket；443 属 Caddy，80 仍属原服务
ss -ltnp | grep -E '3101|443|80'

# 原网站未被改动
systemctl status wikiworldlife-board

# 无令牌健康检查必须 401
curl -s -o /dev/null -w '%{http_code}\n' https://study.pccoding666.com/v1/health   # 期望 401
```

## 6. 回滚与备份

**回滚** = 切软链 + 只重启错题本服务（不删照片、不动原网站、不动 Caddy）：

```bash
ln -sfn /opt/super-error-log/releases/<上一版号> /opt/super-error-log/current
systemctl restart super-error-log
```

**发布前备份**（本机受限备份，不经 HTTP，root 身份在服务器上执行）：

```bash
# 数据目录整体快照（照片+SQLite+配对状态）
tar -czf /root/backup-sel-$(date +%Y%m%d-%H%M).tar.gz -C /var/lib/super-error-log .
# Caddy ACME 证书存储（回滚重装 Caddy 后可恢复证书，避免重新走 ACME 质询）
tar -czf /root/backup-sel-caddy-$(date +%Y%m%d-%H%M).tar.gz -C /var/lib/super-error-log/caddy .
# 环境文件
cp -p /etc/super-error-log/env /root/backup-sel-env-$(date +%Y%m%d-%H%M)
```

数据格式向后兼容性：配对会话/设备文件由 `PairingManager` 原子写入（临时文件 + rename），
`devices.json` 缺字段按空默认解码；回滚到旧版本时新增字段被旧代码忽略，不会破坏数据。

## 7. 资源语义（重要）

- `MemoryLimit=1G`：cgroup v1 内核级上限（含 sharp 原生缓冲）。
- **768 MiB 是应用层准入阈值**（`AdmissionController` 在云端模式拒绝新照片上传）：
  它防的是任务积压，**不宣称内核在 768MiB 节流**。两者独立生效，先到先限。
