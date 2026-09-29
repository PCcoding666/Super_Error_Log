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

本节只用于全新安装。已有服务迁移证书时不要重跑本节、不要预先创建或更改目标证书目录，直接按 §3 暂存新版并进入 §8 的前置检查；§8 要求目标目录不存在，避免覆盖旧迁移资料。

```bash
# 无登录、无家目录的系统用户
useradd --system --no-create-home --shell /usr/sbin/nologin supererrorlog

# 发布目录（root 持有，服务只读）
mkdir -p /opt/super-error-log/releases
# Node 24 解压后放这里：
#   /opt/super-error-log/node-v24/bin/node

# 数据目录（专用用户私有，0700——应用启动时会强制 chmod 0700，保持私有）
install -d -o supererrorlog -g supererrorlog -m 0700 /var/lib/super-error-log

# Caddy ACME 存储目录（caddy 用户私有，0700；证书私钥落这里，见 §4）
# 关键：与应用数据目录平级、互不嵌套。应用每次启动会把 /var/lib/super-error-log
# 强制 chmod 0700（src/mobile/store.ts、src/mobile/pairing.ts）；
# 若 caddy 存储嵌在其内，应用启动一次 caddy 就丢证书访问权（实测踩坑）。
useradd --system --no-create-home --shell /usr/sbin/nologin caddy 2>/dev/null || true
install -d -o caddy -g caddy -m 0700 /var/lib/caddy-super-error-log

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
# v2.0 T2 单进程装配（dist/main.js）新增必填：
# SEL_AI_MODE=bailian：/v2 与主入口共用同一配置入口，缺省 mock 会 fail-hard 拒绝启动。
# SEL_DATA_DIR：/v2 的 node:sqlite 库（app.db）所在目录，必须与 SEL_MOBILE_DATA_DIR 相同。
SEL_AI_MODE=bailian
SEL_DATA_DIR=/var/lib/super-error-log
```

参考 `.env.example`；缺任何必填项服务启动会直接失败（fail-hard，不静默降级 mock）。
`SEL_MOBILE_HOST` 只允许 `127.0.0.1`——公网入口只有 Caddy。
v2.0 T2 起入口为 `dist/main.js`：同一端口（3101）同时服务 `/v1` 识别与 `/v2` 手机接口（均设备令牌鉴权）。
**云端公网入口不挂任何 Web 页面**（`/parent`、`/trends`、`/items` 等一律 404；Web 看板待有登录方案后再设计）。
旧的 `dist/mobile/server.js` 仅保留给开发调试，不再作为线上入口。

注意（T4 预告）：T2 本身不调用 `SEL_AI_*`；自 T4 起 `/v2` 会使用 Web 的 AI 配置
（`SEL_AI_BASE_URL`、`SEL_AI_API_KEY`、`SEL_AI_MODEL*`），届时需与上面的 `SEL_MOBILE_AI_*` 配置为同值。

## 3. 发布新版本

**已有嵌套证书目录的安装：先仅暂存新版发布物与依赖，不切换 `current`；完成 §8 的独立证书迁移后再切换应用。** 新版暂存目录必须是一个新的、经校验的发布目录，不能覆盖既有版本。下面的重启/切链都需要单独获准的部署窗口；本地测试不意味着可以直接执行。

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

# systemd 单元直接来自发布包（版本控制内，可审查），证书存储在独立私有目录：
cp /opt/super-error-log/current/deploy/systemd/super-error-log-caddy.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now super-error-log-caddy
```

> §4 用于新安装。已有实例走 §8，必须先备份实际生效的单元，不能无备份覆盖。若已有其他 Caddy 管理方式或 drop-in，停止并先审阅，不并入原网站服务；不修改 `wikiworldlife-board` 或 80 端口。

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
curl -s -o /dev/null -w '%{http_code}\n' https://study.pccoding666.com/v2/health   # 期望 401

# 云端不挂任何 Web 页面：页面路径一律 404（匿名与带令牌均如此）
curl -s -o /dev/null -w '%{http_code}\n' https://study.pccoding666.com/parent      # 期望 404
curl -s -o /dev/null -w '%{http_code}\n' https://study.pccoding666.com/            # 期望 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://study.pccoding666.com/batches  # 期望 404
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
tar -czf /root/backup-sel-caddy-$(date +%Y%m%d-%H%M).tar.gz -C /var/lib/caddy-super-error-log .
# 环境文件
cp -p /etc/super-error-log/env /root/backup-sel-env-$(date +%Y%m%d-%H%M)
```

配对会话/设备文件由 `PairingManager` 原子写入（临时文件 + rename）。**原子写入不等于任意版本可以安全回滚**：发布前必须核对当前版本的任务、预算和配对格式兼容性。尤其不能在有未完成任务时回退到忽略持久化预算的旧识别代码；如需应用回滚，先关闭新增准入、确认识别工作已安全停止，再使用本轮验证过的兼容版本。备份不自动删除或覆盖现有学生资料。

## 7. 资源语义（重要）

- `MemoryLimit=1G`：cgroup v1 内核级上限（含 sharp 原生缓冲）。
- **768 MiB 是应用层准入阈值**（`AdmissionController` 在云端模式拒绝新照片上传）：
  它防的是任务积压，**不宣称内核在 768MiB 节流**。两者独立生效，先到先限。

## 8. 证书存储迁移与安全回滚（需单独批准执行）

本节是待部署执行的方案，不代表已迁移。旧 `XDG_DATA_HOME=/var/lib/super-error-log/caddy` 嵌在应用会强制改成 0700 的目录内；新值为 `/var/lib/caddy-super-error-log`。注意 **Caddy 实际存储是 `$XDG_DATA_HOME/caddy`**，所以迁移整份 XDG 根目录，必须保留其下 `caddy/` 层及证书、私钥、ACME 账户。参见 [Caddy 官方文件目录说明](https://caddyserver.com/docs/conventions#data-directory)。

### 8.1 暂存新版并只做前置检查

按 §3 上传、校验、解包到新的发布目录并安装 Linux 生产依赖，**此时不切 current**。准备器从明确的新版路径取单元，旧 current 不含新增单元也不影响准备。准备器只写私有备份目录，不碰活动配置、证书或服务；`--check` 不写文件。

以下在获准部署窗口内由 root 分段执行，任一步失败即停止，不继续复制或重启：

```bash
set -euo pipefail
read -r -p '已校验的新版发布目录绝对路径: ' SEL_NEW_RELEASE
test -d "$SEL_NEW_RELEASE"
test "$SEL_NEW_RELEASE" != /opt/super-error-log/current
test -f "$SEL_NEW_RELEASE/deploy/prepare-caddy-migration.mjs"
SEL_OLD_CADDY_UNIT="$(systemctl show super-error-log-caddy -p FragmentPath --value)"
test -f "$SEL_OLD_CADDY_UNIT"
# 未处理的 drop-in 可能覆盖存储路径或运行用户，必须先人工审阅，不能自动忽略。
test -z "$(systemctl show super-error-log-caddy -p DropInPaths --value)"
SEL_CADDY_PREP_PARENT="$(mktemp -d /root/sel-caddy-migration-XXXXXX)"
SEL_CADDY_PREP="$SEL_CADDY_PREP_PARENT/prepared"
/opt/super-error-log/node-v24/bin/node "$SEL_NEW_RELEASE/deploy/prepare-caddy-migration.mjs" \
  --release "$SEL_NEW_RELEASE" --current-unit "$SEL_OLD_CADDY_UNIT" \
  --legacy-xdg /var/lib/super-error-log/caddy --staging "$SEL_CADDY_PREP" --check
```

检查旧单元声明的 XDG 路径与实际一致，以及新版 Caddyfile 与当前服务兼容；当前包不改变 Caddyfile。未知配置、路径不一致、旧存储为空或包含符号链接时准备器拒绝自动处理，应调查而非绕过。备份包含私钥，不上传 Git、报告或公网。

### 8.2 获准短暂停止 Caddy，形成一致备份并迁移

只停止独立的 `super-error-log-caddy`，不停止原网站。记录当前时间、证书指纹、有效期及原网站状态。Caddy 停止后再备份，避免归档时证书维护线程同时修改文件。

```bash
systemctl stop super-error-log-caddy
/opt/super-error-log/node-v24/bin/node "$SEL_NEW_RELEASE/deploy/prepare-caddy-migration.mjs" \
  --release "$SEL_NEW_RELEASE" --current-unit "$SEL_OLD_CADDY_UNIT" \
  --legacy-xdg /var/lib/super-error-log/caddy --staging "$SEL_CADDY_PREP"
# 准备器成功才会生成 ready=true 的 manifest；保留目录路径供恢复使用。
# 备份：previous.service、legacy-xdg.tar；候选：next.service、rollback.service。
systemd-analyze verify "$SEL_CADDY_PREP/next.service"
systemd-analyze verify "$SEL_CADDY_PREP/rollback.service"
/opt/super-error-log/node-v24/bin/node "$SEL_NEW_RELEASE/deploy/prepare-caddy-migration.mjs" \
  --create-private-destination /var/lib/caddy-super-error-log
tar -xpf "$SEL_CADDY_PREP/legacy-xdg.tar" -C /var/lib/caddy-super-error-log
chown -R caddy:caddy /var/lib/caddy-super-error-log
chmod 0700 /var/lib/caddy-super-error-log
diff -qr /var/lib/super-error-log/caddy /var/lib/caddy-super-error-log
test -d /var/lib/caddy-super-error-log/caddy
runuser -u caddy -- test -r /var/lib/caddy-super-error-log/caddy
runuser -u caddy -- test -w /var/lib/caddy-super-error-log/caddy
if runuser -u caddy -- test -x /var/lib/super-error-log; then
  echo '学生数据目录可被 caddy 穿越，停止迁移并调查权限' >&2
  exit 1
fi
install -o root -g root -m 0644 "$SEL_CADDY_PREP/next.service" /etc/systemd/system/super-error-log-caddy.service
systemctl daemon-reload
systemctl start super-error-log-caddy
```

目标目录必须全新；已存在的目录（即使为空）或符号链接都会在改变权限、所有者或内容之前被拒绝，须先人工核对是否有此前迁移/续期产生的新资料，**不覆盖、不清空**。任何失败保留旧目录、目标目录和准备目录；准备器失败留下的半份目录不用于上线，另建准备目录调查后重试。不要自动恢复旧权限或重新签证书以掩盖迁移失败。

### 8.3 验收后才切换应用

- 标准 TLS 握手成功且证书身份、有效期与迁移前一致，无令牌健康请求 401。不要跳过证书校验。
- 用不同 UID 实测 Caddy 读写实际 `caddy/` 存储，并确认不能读取应用照片与配对资料；应用初始化/重启后这两个条件仍成立。
- 查看**迁移开始时间之后**的完整 Caddy 日志，核对加载现有证书、没有 `permission denied`，后续维护也正常。一次 401 或日志最后 20 行不能证明证书维护通过；未观察到维护时保留待验收项，不强制续签。
- 核对 443 仍归独立 Caddy，80 与原网站保持原状。
- 上述通过后才按 §3 切应用软链、重启错题本并验收。云端和真机结果另行记录，不由本地合成测试替代。

### 8.4 回滚不是把证书放回旧目录

应用问题：按 §6 回到已验证兼容的应用版本，**Caddy 与独立存储保持不变**。旧应用不能再影响证书父目录权限。

新 Caddy 单元问题：准备器的 `rollback.service` 保留原单元运行参数，但将 XDG 与可写路径固定到新的独立目录。保留 `previous.service` 只用于对照，**禁止直接装回它**。先确认迁移后的独立存储已完整、Caddy 用户可读写，且两份单元经 `systemd-analyze verify` 通过，再在获准恢复窗口执行：

```bash
systemctl stop super-error-log-caddy
install -o root -g root -m 0644 "$SEL_CADDY_PREP/rollback.service" /etc/systemd/system/super-error-log-caddy.service
systemctl daemon-reload
systemctl start super-error-log-caddy
```

如果失败发生在完整迁移之前，先保持 Caddy 停止，修复前置问题并将已验证归档恢复到**新的空独立目录**，完成 8.2 权限/内容检查后再启动安全回滚单元。不能把故障目标直接覆盖为旧快照；若已有新证书/账户写入，先私有备份并人工合并。没有可用且可验证的备份时停止自动恢复、交由运维处理。整个流程不删除旧存储，不用 777、公开学生目录或 root 运行 Caddy 来绕过问题。
