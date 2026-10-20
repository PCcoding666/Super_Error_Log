# 自动发布入口（2026-10-15）

用户已批准集成分支合并后自动上线，见 [GitHub 自动发布](ci/README.md)。下面的手动步骤保留给首次装机和人工维护；日常修改通过 PR → CI → 自动发布。

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
# 单次视觉模型调用超时。缺省 90000（90 秒），与 SEL_AI_TIMEOUT_MS 对齐；同题同阶段最多 3 次（首次 + 两次重试）。
SEL_MOBILE_AI_TIMEOUT_MS=90000
# v2.0 T2 单进程装配（dist/main.js）新增必填：
# SEL_AI_MODE=bailian：/v2 与主入口共用同一配置入口，缺省 mock 会 fail-hard 拒绝启动。
# SEL_DATA_DIR：/v2 的 node:sqlite 库（app.db）所在目录，必须与 SEL_MOBILE_DATA_DIR 相同。
SEL_AI_MODE=bailian
SEL_DATA_DIR=/var/lib/super-error-log
# v2.0 T4 起必填：/v2 的追问、修改建议、打印辅导走这组配置；与上面的 SEL_MOBILE_AI_* 同值。
# 缺接口地址、密钥或模型时 dist/main.js 启动即失败（不会带着缺配置上线后悄悄退回固定问句）。
SEL_AI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
SEL_AI_API_KEY=<百炼密钥，与 SEL_MOBILE_AI_API_KEY 相同>
SEL_AI_MODEL=<模型名>
# 可选（2026-10-09 起）：学生网页版「说说为什么错」的语音转写模型，缺省 qwen-audio-3.1-asr-flash（2026-10-11 起，此前是 qwen3-asr-flash）；
# 用上面同一个 SEL_AI_API_KEY——**生产用的这把百炼密钥必须有 qwen-audio-3.1-asr-flash 的调用权限，这一点还没有从这里核实过**，
# 部署前用 10.4 第 6 步实测；没有权限时语音转写会返回 502，网页会提示「这次没转成文字…直接打字」，其余功能不受影响。
# 该模型只在百炼原生接口 https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation 上提供（代码里写死，不用另配环境变量，出站主机仍是 dashscope.aliyuncs.com）。
# SEL_AI_BASE_URL 仍须是上面的百炼北京兼容地址，否则启动即失败。
# SEL_AI_MODEL_ASR=qwen-audio-3.1-asr-flash
# 可选（2026-10-03 起）：配对二维码里发给手机的入口。缺省发 IP 直连 https://8.163.96.197；
# 只允许这两个值之一，其他值启动即失败。兑换时两个入口都接受。见 §9。
# SEL_MOBILE_PAIRING_URL=https://study.pccoding666.com
```

参考 `.env.example`；缺任何必填项服务启动会直接失败（fail-hard，不静默降级 mock）。
`SEL_MOBILE_HOST` 只允许 `127.0.0.1`——公网入口只有 Caddy。
v2.0 T2 起入口为 `dist/main.js`：同一端口（3101）同时服务 `/v1` 识别与 `/v2` 手机接口（均设备令牌鉴权）。
**云端公网入口不挂旧的 Web 看板**（`/parent`、`/trends`、`/items` 等一律 404；Web 看板待有登录方案后再设计）。学生网页版为 `/s/`（见 §10）；启用学生邀请码 host 的开发版本另有独立登录的只读管理后台 `/admin/`（见文末说明）。
旧的 `dist/mobile/server.js` 仅保留给开发调试，不再作为线上入口。

`/v2` 使用 Web 的 AI 配置（`SEL_AI_BASE_URL`、`SEL_AI_API_KEY`、`SEL_AI_MODEL*`），与上面的 `SEL_MOBILE_AI_*` 配置为同值；
启动守卫见 `src/v2/aiConfigGuard.ts`。需要按阶段指定模型时可加 `SEL_AI_MODEL_FOLLOWUP`、`SEL_AI_MODEL_CORRECT`、`SEL_AI_MODEL_COACH`。

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
# cgroup v1 实测（systemctl show 不是内核读回）。先确认这台机器用的是哪一档，再对数字。
# 推荐档（4 核 / 8 GB，单元文件默认值）：
#   memory.limit_in_bytes = 4294967296
#   cpu.cfs_quota_us = 300000（300% × 100000 period）
# 当前广州小机（已安装 small-box.conf）：
#   memory.limit_in_bytes = 1073741824
#   cpu.cfs_quota_us = 150000（150% × 100000 period）
cat /sys/fs/cgroup/memory/system.slice/super-error-log.service/memory.limit_in_bytes
cat /sys/fs/cgroup/cpu/system.slice/super-error-log.service/cpu.cfs_quota_us
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

# 学生网页版（§10）：外壳公开，内容要设备令牌 cookie
curl -s -o /dev/null -w '%{http_code}\n' https://study.pccoding666.com/s/manifest.webmanifest   # 期望 200
curl -s https://study.pccoding666.com/s/ | grep -c '先连上服务器'                              # 期望 1（没 cookie 只有连接页）
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

单元文件 `deploy/systemd/super-error-log.service` 的默认值是 **4 核 / 8 GB 推荐档**：`MemoryMax=4G`、`MemoryLimit=4G`（systemd 239 的 cgroup v1 读 `MemoryLimit`）、`CPUQuota=300%`。父子进程和全部学生 worker 共用这一份 cgroup。

当前广州机器是 **2 核 / 1.8 GB**。自动发布不会安装单元文件。人工发布到这台机器时，必须在重启前装上 `deploy/systemd/super-error-log.service.d/small-box.conf`（`MemoryMax=1G`、`CPUQuota=150%`），并在 `/etc/super-error-log/env` 写上小机档：

```
SEL_MAX_STUDENTS=100
SEL_WORKER_IDLE_MS=720000
SEL_MAX_LIVE_WORKERS=3
SEL_GLOBAL_AI_CONCURRENCY=1
SEL_GLOBAL_IMAGE_CONCURRENCY=1
SEL_SERVICE_MEMORY_MIB=1024
```

只换 4G 单元、不装 drop-in，会让 cgroup 上限高于物理内存。只改代码、不改环境，学生 worker 会按 4G 预算估算自己的准入阈值。

小机档不用把 `SEL_STUDENT_AI_CONCURRENCY` 改成 1。缺省 3 只表示一个学生的多张照片可以一起进入识别；`SEL_GLOBAL_AI_CONCURRENCY=1` 和 `SEL_GLOBAL_IMAGE_CONCURRENCY=1` 仍让整台机器同时只有一次视觉调用、一次重图片处理。

应用层 RSS 准入（超过后暂停接收新识别任务，内存回落再恢复）按下面计算，**不是内核节流，也不再是固定 768MiB**：

- `SEL_RSS_ADMISSION_MIB` 若设置了，就用它（64–8192）。
- 否则看 `SEL_SERVICE_MEMORY_MIB`（缺省 4096，对应推荐档的 4G）。
- 主进程：预算的 60%，夹在 256–512 MiB。缺省 512 MiB。
- 学生 worker：预算的一半 ÷ `SEL_MAX_LIVE_WORKERS`（至少按 1 份），夹在 192–512 MiB。推荐档缺省 256 MiB；小机档 192 MiB。

容量相关环境变量（未写则用缺省）：

| 变量 | 缺省 | 含义 |
| --- | --- | --- |
| `SEL_MAX_STUDENTS` | 100 | 注册表里最多多少个学生空间。打开注册表时读取，降低后不删除已有账号 |
| `SEL_WORKER_IDLE_MS` | 720000 | 空闲多久退出 worker。0 表示不因空闲退出 |
| `SEL_MAX_LIVE_WORKERS` | 8 | 同时存活的学生进程。0 表示不限制。超出时先请最久没用且空闲的退出；都在忙则本次 503 |
| `SEL_GLOBAL_AI_CONCURRENCY` | 2 | 所有学生加起来，同时进行的视觉模型调用 |
| `SEL_GLOBAL_IMAGE_CONCURRENCY` | 2 | 所有学生加起来，同时进行的 sharp 等重图片处理 |
| `SEL_STUDENT_AI_CONCURRENCY` | 3 | 一个学生同时处理的照片数。同一张照片里的题和阶段仍串行。同时打到模型的次数不会超过上面的全局上限 |
| `SEL_SERVICE_MEMORY_MIB` | 4096 | 估算 RSS 准入用的服务预算，应与 cgroup 内存上限同一量级 |
| `SEL_MOBILE_AI_TIMEOUT_MS` | 90000 | 单次移动端模型调用超时 |

学生空间仍是一人一进程、一人一个 SQLite。启动时不为已注册学生预热。第一次打开才拉起；空闲退出前若还有正在转发的请求、排队或在跑的识别、或正在准备的打印，就留下。磁盘上没做完的任务，下次拉起时继续。

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

## 9. IP 直连入口（自签证书 + App 固定证书；用户书面批准"同意部署"后按顺序执行）

背景：从境外连域名时 TLS 握手被重置（`docs/quality/2026-10-02-deploy-0.2.0-rc3.md`），不带 SNI 的握手正常。App 改为直连公网 IP `8.163.96.197`，域名入口保留。按 IP 连接时 ATS 不约束、系统也不信任自签证书，安全全靠 App 内固定的那张证书（`iOS/StudentApp/Resources/cloud-ip-cert.pem`）：服务器出示的证书必须与它逐字节一致，系统信任的证书也拒绝。

### 9.1 范围

- 新增：`/etc/super-error-log/tls-ip/`（证书与私钥）；Caddyfile 新增 `https://8.163.96.197` 站点和全局 `default_sni 8.163.96.197`（手机按 IP 连接不发 SNI，ECS 网卡是内网地址，不设置时 Caddy 找不到证书）；可选环境变量 `SEL_MOBILE_PAIRING_URL`（§2）。
- 不动：80 端口与原网站、域名站点及其 ACME 证书与续期、Caddy systemd 单元、应用数据。
- 顺序约束：新版 Caddyfile 引用证书文件，文件不存在时 Caddy 整体起不来，域名入口也会断。所以**先生成证书（9.3），再切 current，最后重启 Caddy（9.5）**。
- 下面的服务器命令沿用 §8 的写法，在 `set -euo pipefail` 的 root shell 里分段执行：任一检查失败即停下，不往下做。

### 9.2 暂存新版（不切 current）

按 §3 上传、校验、解包到新的发布目录，并在其中 `npm ci --omit=dev`；**此时不切 current、不重启任何服务**。按 §6 做发布前备份。

### 9.3 在服务器上生成证书（root）

```bash
set -euo pipefail
read -r -p '已校验的新版发布目录绝对路径: ' SEL_NEW_RELEASE
test -f "$SEL_NEW_RELEASE/deploy/generate-ip-cert.sh"
getent group caddy                       # 期望一行 caddy:x:<gid>:
test ! -e /etc/super-error-log/tls-ip    # 已存在就停下核对；不删除、不覆盖
bash "$SEL_NEW_RELEASE/deploy/generate-ip-cert.sh" --ip 8.163.96.197 --dir /etc/super-error-log/tls-ip --group caddy
```

预期输出（指纹每次不同，**记下来**，9.4 和 9.6 要核对）：

```
证书已生成：/etc/super-error-log/tls-ip/cert.pem（拷回仓库供 App 固定）
私钥：/etc/super-error-log/tls-ip/key.pem（0640，组 caddy；只留在本机，不要拷出、不要打印）
subject=CN = 8.163.96.197
notAfter=<约两年后的日期> GMT
SHA256 Fingerprint=<32 组冒号分隔的十六进制>
```

脚本失败会删掉它刚建的目录（不碰其他文件），修好原因后重跑。然后核对权限：

```bash
stat -c '%A %U:%G %n' /etc/super-error-log/tls-ip /etc/super-error-log/tls-ip/*
# 期望：
# drwxr-x--- root:caddy /etc/super-error-log/tls-ip
# -rw-r--r-- root:root /etc/super-error-log/tls-ip/cert.pem
# -rw-r----- root:caddy /etc/super-error-log/tls-ip/key.pem
runuser -u caddy -- test -r /etc/super-error-log/tls-ip/key.pem && echo 'caddy 可读私钥'
runuser -u supererrorlog -- test -r /etc/super-error-log/tls-ip/key.pem || echo '应用用户读不到私钥'
```

### 9.4 证书拷回仓库，构建 App（本地 Mac）

只拷 `cert.pem`，**私钥永远不离开服务器**。

```bash
cd ~/MyProject/Super_Error_Log          # 已合入本分支的工作区
mkdir -p iOS/StudentApp/Resources
scp root@<ECS>:/etc/super-error-log/tls-ip/cert.pem iOS/StudentApp/Resources/cloud-ip-cert.pem
openssl x509 -in iOS/StudentApp/Resources/cloud-ip-cert.pem -noout -subject -fingerprint -sha256
# 期望：subject 含 CN=8.163.96.197；指纹与 9.3 记下的完全一致
grep -c 'PRIVATE KEY' iOS/StudentApp/Resources/cloud-ip-cert.pem   # 期望 0
git add iOS/StudentApp/Resources/cloud-ip-cert.pem
git commit -m 'chore(ios): pin the IP entry certificate'
```

按 `iOS/README.md` 构建并安装 App。装机前确认构建产物里有这张证书且指纹一致：

```bash
openssl x509 -in <构建产物目录>/SuperErrorLog.app/cloud-ip-cert.pem -noout -fingerprint -sha256   # 与 9.3 一致
```

App 里没有这个文件时，连 IP 入口一律失败（设计如此：没有可比对的证书就拒绝）；域名入口不受影响。

### 9.5 切换应用并重启 Caddy（root）

沿用 9.3 的 shell（`SEL_NEW_RELEASE` 已设置）；换了会话就先重新设置它。

```bash
# 先校验新版 Caddyfile（会实际加载证书文件），通过后才切换。
/usr/local/bin/caddy validate --config "$SEL_NEW_RELEASE/deploy/caddy/Caddyfile" 2>&1 | tail -n 1
# 期望 Valid configuration。若报 open /etc/super-error-log/tls-ip/...: no such file，说明 9.3 没做：停下
ln -sfn "$SEL_NEW_RELEASE" /opt/super-error-log/current
systemctl restart super-error-log
systemctl is-active super-error-log                      # 期望 active
systemctl restart super-error-log-caddy                  # admin off，只能重启；域名入口随之中断约 1 秒
systemctl is-active super-error-log-caddy                # 期望 active
journalctl -u super-error-log-caddy --since '2min ago' --no-pager | grep -E 'permission denied|"level":"error"' | grep -v 'config autosave' || echo '无新错误'
journalctl -u super-error-log-caddy --since '2min ago' --no-pager | grep -c 'already loaded' || true   # 期望 1：IP 证书来自文件，不走 ACME
ss -ltnp | grep -E ':(80|443|3101) '                     # 443 仍是 caddy，80 仍是原网站，3101 只在 127.0.0.1
```

日志里两条是预期的：`no OCSP stapling for [8.163.96.197]`（warn，自签证书没有 OCSP）；`unable to create folder for config autosave: mkdir /home/caddy: permission denied`（迁移前就有的既有报错，见 `docs/quality/2026-09-27-caddy-maintenance.md`，与本节无关）。

切换后新生成的配对二维码默认带 IP 地址。手机还没装 9.4 的新版 App、又必须重新配对时，临时在 `/etc/super-error-log/env` 加 `SEL_MOBILE_PAIRING_URL=https://study.pccoding666.com` 并 `systemctl restart super-error-log`；装好新版后删掉这行再重启。

### 9.6 验证

服务器上（不经外网）：

```bash
openssl s_client -connect 127.0.0.1:443 -noservername </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256
# 期望：与 9.3 的指纹一致（不带 SNI 拿到的是 IP 证书）
echo | openssl s_client -connect 127.0.0.1:443 -servername study.pccoding666.com 2>/dev/null | openssl x509 -noout -issuer -enddate
# 期望：仍是 Let's Encrypt 签发，到期日与切换前一致（域名入口不变）
curl -s -o /dev/null -w '%{http_code}\n' https://study.pccoding666.com/v2/health   # 期望 401
```

从外部（如境外的本地 Mac；在仓库根目录执行）：

```bash
CERT=iOS/StudentApp/Resources/cloud-ip-cert.pem
curl -sS -o /dev/null -w '%{http_code}\n' --cacert "$CERT" https://8.163.96.197/v2/health   # 期望 401
curl -sS -o /dev/null -w '%{http_code}\n' --cacert "$CERT" https://8.163.96.197/v1/health   # 期望 401
curl -sS -o /dev/null -w '%{http_code}\n' --cacert "$CERT" https://8.163.96.197/parent      # 期望 404
curl -sS -o /dev/null https://8.163.96.197/v2/health; echo "exit=$?"
# 不给证书：期望失败（exit=60，证书不受信任）——说明 IP 入口不是靠系统信任放行的
```

国内网络到 IP 入口的可达性只能由国内的手机实测（9.7）。

### 9.7 手机改用 IP 入口

1. 装好 9.4 构建的新版 App。
2. 服务器上生成配对码，确认地址是 IP：
   ```bash
   /opt/super-error-log/node-v24/bin/node /opt/super-error-log/current/dist/mobile/admin-cli.js --data-dir /var/lib/super-error-log pairing-code
   # 期望载荷中 "httpsUrl": "https://8.163.96.197"；5 分钟内有效、只能用一次
   ```
3. 按既有方式做成二维码，手机扫码；连接状态应显示「可以上传」。
4. 已配对、没重新扫码的手机继续走域名（App 不会自动改入口）。旧版 App 扫 IP 二维码会提示「配对二维码指向的服务不受信任」，先升级 App。

### 9.8 回滚

- **只是手机连 IP 有问题**：`/etc/super-error-log/env` 加 `SEL_MOBILE_PAIRING_URL=https://study.pccoding666.com`，`systemctl restart super-error-log`，用域名二维码重新配对（新版 App 仍接受域名）。Caddy 不用动。
- **Caddy 起不来，或域名入口受影响**：切回上一版（旧版 Caddyfile 没有 IP 站点），应用与 Caddy 都重启：
  ```bash
  ln -sfn /opt/super-error-log/releases/<上一版号> /opt/super-error-log/current
  systemctl restart super-error-log
  systemctl restart super-error-log-caddy
  systemctl is-active super-error-log super-error-log-caddy                            # 期望两行 active
  curl -s -o /dev/null -w '%{http_code}\n' https://study.pccoding666.com/v2/health    # 服务器上执行，期望 401
  ```
- `/etc/super-error-log/tls-ip/` **保留不删**：旧版不引用它，再次前滚时直接复用。不要重新生成——新证书与 App 里固定的不一致，IP 入口会全部被拒。

### 9.9 换证书

证书有效期 730 天。App 只比对证书本身、不看有效期，所以到期不会让 App 断开，但 9.6 的 `curl --cacert` 会报过期。换证书（到期前或私钥疑似泄露时）：

1. 用新目录重跑 9.3（如 `--dir /etc/super-error-log/tls-ip-<年份>`）；脚本拒绝覆盖已有目录。
2. 新发布版本的 Caddyfile 改用新目录的两条路径；仓库里替换 `iOS/StudentApp/Resources/cloud-ip-cert.pem`。
3. App 只固定一张证书：新 App 连不上旧证书、旧 App 连不上新证书。先装好新 App，紧接着按 9.5 切换服务器；中间这段可临时用域名二维码过渡。
4. 旧目录改名留存，不删除。

## 10. 学生网页版（`/s/`，Safari「添加到主屏幕」；2026-10-09 起）

在 Apple 开发者账号批下来之前，学生用 iPhone 的 Safari 打开网页版、添加到主屏幕当 App 用。网页版跟 App 是同一个服务、同一套数据和规则。

### 10.1 部署上不需要新东西

- 由同一个 `super-error-log` 单元（`dist/main.js`，127.0.0.1:3101）在云端模式下直接提供 `/s/`；**没有新进程、新端口、新依赖、新目录**。样式、脚本、图标都编译在 `dist/` 里（发布白名单不变）。
- Caddy 不用改：`/s/` 经现有的 `study.pccoding666.com` 站点反代过去（请求体上限 15 MB 不变，照片和录音都在其内）。Caddyfile 没开访问日志，配对链接里的一次性码不会落进日志。
- 环境变量：只多一个可选的 `SEL_AI_MODEL_ASR`（§2，缺省 `qwen-audio-3.1-asr-flash`，用同一个百炼密钥）。**生产这把密钥是否有该模型的调用权限还没核实过**（语音转写走百炼原生接口，出站主机仍是 `dashscope.aliyuncs.com`，不需要新的出站放行）。百炼配置不全时 `dist/main.js` 启动即失败（与 /v2 其他模型调用同一个守卫），不会悄悄退回 mock。
- 时区：网页上的「今天」「距练习纸生成几天」、录结果可选的日期，和服务器的回传日期校验、ISO 周一样，都按**服务器进程的时区**算。上线前确认 `timedatectl | grep 'Time zone'` 是 `Asia/Shanghai`；如果是 UTC，北京时间 0–8 点之间网页和 App 的「今天」会差一天（本次不改单元文件，需要时另行批准加 `Environment=TZ=Asia/Shanghai`）。

### 10.2 前提：学生手机上必须是**受信任的 HTTPS 主机名**

- 网页版只能走域名 `https://study.pccoding666.com/s/`（Let's Encrypt 证书，Safari 信任）。**IP 入口 `https://8.163.96.197` 的自签证书只给 App 固定用，Safari 不接受**——在 Safari 里打开会报「此连接非私人连接」，「添加到主屏幕」后的网页 App、摄像头上传、录音、Service Worker 都要求安全连接，不能让学生点「继续访问」。
- §9 的背景是「从境外连域名时 TLS 握手被重置」。**所以第一件事是用学生手机、在学生实际用的网络（家里 Wi-Fi 和手机流量各试一次）上打开 `https://study.pccoding666.com/s/`**，能看到「先连上服务器」才往下做。
- 如果在学生的网络里域名也被重置：网页版这条路走不通，需要另一个受信任的主机名，例如给域名办 ICP 备案、换一个在学生网络里可达且有公共 CA 证书的主机名再反代过来，或者给 IP 申请公共 CA 签发的 IP 证书（Let's Encrypt 已开始签发短期 IP 证书；Caddy 版本与签发条件本次未核实）。这些都要 Peng 决定，不在本次范围。

### 10.3 配对（网页版）

- 同一个命令同时给出 App 的二维码载荷和网页版链接（同一次会话，二选一，5 分钟内有效，只能用一次）：
  ```bash
  /opt/super-error-log/node-v24/bin/node /opt/super-error-log/current/dist/mobile/admin-cli.js --data-dir /var/lib/super-error-log pairing-code
  # 输出最后一行：https://study.pccoding666.com/s/pair?code=…
  ```
  链接里载荷的 `httpsUrl` 仍按 `SEL_MOBILE_PAIRING_URL` 发（缺省 IP），网页版不用它，只用链接本身的域名；需要别的受信任主机名时加 `--web-base https://<主机名>`。
- 把链接发给学生（或做成二维码让他用「相机」扫）。**要在 Safari 里打开**：在微信里打开时页面会提示「在 Safari 中打开」，并且不让在微信里连接（码只能用一次）。打开后点「连接这台手机」才兑换。
- 设备列表里显示为「网页版 · iPhone Safari」；撤销方式与 App 相同（`admin-cli … revoke <deviceId>`），撤销后网页显示「需要重新扫码」。
- 主屏幕上的网页 App 在 iOS 上可能有自己独立的 cookie：如果从主屏幕打开时又让连接，再生成一条链接，让学生在主屏幕 App 的连接页里「粘贴链接」连接。

### 10.4 第一次真机使用的 2 分钟检查

1. 服务器上：`curl -s -o /dev/null -w '%{http_code}\n' https://study.pccoding666.com/s/manifest.webmanifest` 期望 200；`/v2/health` 仍 401，`/` 仍 404。
2. 学生手机（学生的网络）Safari 打开 `https://study.pccoding666.com/s/`：看到「先连上服务器」，地址栏没有证书警告。
3. 生成配对链接（10.3），在手机 Safari 打开 → 点「连接这台手机」→ 看到「连上了 ✓」和「今天大约 13 分钟，一共 5 步」。
4. 分享 →「添加到主屏幕」→ 从主屏幕图标打开：全屏、没有地址栏，仍是「今天」（如果是连接页，按 10.3 最后一条粘贴新链接）。
5. 点「拍第一页」→「同意，上传」→ 拍一页（用合成或无个人信息的纸）→ 出现「已拍 1 张」→「拍完了，下一步」→ 一两分钟内变成「找到 N 道…」。
6. 可选：在「说说为什么错」里点「点一下开始说」，允许麦克风，说一句话，文字出现在文本框里（这是第一次在生产上真实调用 `qwen-audio-3.1-asr-flash`，同时验证生产密钥有这个模型的权限；出现「这次没转成文字」多半是密钥没有该模型权限或额度，先查这个）。


## 学生邀请码手机版网页（2026-10-15）

学生入口为 `/s/`。设置 `SEL_STUDENT_HOST_ENABLED=1` 后，网页改用一次性邀请码登录，每个学生使用独立目录与子进程。`/v1`、`/v2` 原生App维持原数据。目录由 `SEL_STUDENT_HOST_DIR` 指定，建议 `/var/lib/super-error-log/student-host`，私有权限0700。注册上限缺省 100（`SEL_MAX_STUDENTS`，与自助注册同一处读取）。进程不按注册人数常驻：第一次打开才启动，空闲约 12 分钟后退出；同时存活的进程缺省最多 8 个（小机请改成 3）。视觉调用和重图片处理由父进程限流，缺省各 2 路（小机请改成 1）。学生之间不共享档案。容量相关变量和两档 cgroup 限制见 §7。本改动会让自动发布拒绝，须走人工发布，见 `docs/quality/2026-10-20-fifty-students.md`。

管理员以服务用户运行 `dist/studentHost/admin-cli.js create [role] | list | invite <studentId> | set-role <studentId> <role> | revoke-sessions <studentId>`。邀请码仅在生成时显示，勿写入日志或公开文档。邀请码7天一次性；登录30天。补发到同一学生保留记录。管理后台使用独立管理员密码，不能使用学生邀请码登录。

账号身份（role）只是标签：`student`/`parent`/`teacher`/`admin`，新建缺省 `student`，老账号迁移后一律 `student`。身份只能由管理员在本机用 `set-role` 修改；浏览器、网页表单、查询串都不能改身份，身份也不参与任何鉴权——每个账号仍是自己独立的空间、会话和数据。家长/老师/管理员的专属权限与账号关系尚未实现：非学生身份登录看到的仍是同一套错题本学习功能，设置页会注明「专属功能后续开放」。

本轮部署检查与回滚见 `docs/quality/2026-10-15-student-web-release.md`（源码文档不随生产包部署）。关闭flag/回滚旧包不会删除新的学生目录。


## 管理后台：账号用量与 AI 性能（2026-10-20 开发版本，尚未部署）

在已启用 `SEL_STUDENT_HOST_ENABLED=1` 的同一服务上提供 `/admin/`。Caddy 现有整站反代已覆盖该路径，无需增加端口。只有 host 主进程提供后台，学生 worker 和旧单学生部署不提供。

部署包含本功能的代码后，由服务器管理员以服务用户运行一次下列命令，生成管理密码：

```sh
sudo -u supererrorlog env SEL_STUDENT_HOST_DIR=/var/lib/super-error-log/student-host \
  /opt/super-error-log/node-v24/bin/node \
  /opt/super-error-log/current/dist/studentHost/admin-cli.js admin-password
```

`SEL_STUDENT_HOST_DIR` 必须和运行中的应用相同。命令只打印一次随机密码；复制到密码管理器，不写入仓库或公开日志。打开 `https://study.pccoding666.com/admin/` 输入该密码。再次运行同一命令会重置密码，并立即注销所有旧管理会话，不影响学生会话与学习记录。管理会话有效期12小时；默认没有密码，不能登录。无需为初始化/轮换密码重启服务。

后台功能：

- 所有邀请码的独立编号、所属账号、创建/兑换/到期状态；编号不是登录原码。旧邀请码只存哈希，不能还原。
- 每账号的累计录入题目照片、错题、练习包、已生成打印包、复盘、重做次数，以及最近活跃时间。题目照片统计不包含练习作答或反思附件。
- 按账号、UTC+8日期、模型、功能筛选输入/输出 tokens、调用次数、接口成功率、平均与P95耗时；调用明细每页50条，汇总覆盖全部筛选结果。
- 失败区分超时、取消、限流、网络/服务错误、配置认证错误和无效响应；不暴露模型原始错误正文、学生内容、音频、图片或密钥。

统计口径与覆盖：

- 新采集写入每学生目录的 `ai-usage.db`，一次实际 HTTP 尝试算一次调用，重试分别计数。Mock 不发模型请求，不计为真实用量。
- 输入/输出 token 采用供应商实际返回的 usage。未知为“未采集”；已报告 tokens 是可计量部分，不能当作供应商完整账单。
- 耗时从发出请求到读取并解析响应完成，不包括排队或后续业务处理；平均和P95仅使用有耗时的样本，P95采用最近秩（向上取整第95百分位）。
- 接口成功表示请求及客户端响应解析成功，不等同于识别准确、业务完整性检查通过或学生掌握。失败调用已返回的 usage 仍计入已知用量。
- 历史视觉 attempts 日志按白名单恢复元数据，并按调用ID和新采集去重。旧日志没有耗时就不能补算；旧文本/语音调用未完整记录。进程被强制终止、未写入的调用无法重建。后台标明历史来源、用量采集比例及读取/写入异常。
- “已生成打印包”统计 ready 快照，不是实际纸张打印次数。最近活跃由登录/有效页面访问与已有活动记录推得；升级前没有记录的访问无法追溯。

`admin.db` 在 host 目录保存 scrypt 密码派生值和会话哈希；管理 cookie 与学生 cookie 独立。学习库以只读连接查询，不启动/恢复学生 worker。无需新环境变量或运行时依赖。回滚旧代码时这些新增统计文件会被忽略，额外注册表列不改变旧邀请码兑换规则。
