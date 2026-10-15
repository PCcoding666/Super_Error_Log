# Caddy 证书存储迁移维护（2026-09-27）

范围：仅证书存储迁移 + `super-error-log-caddy.service` 单元。不动应用发布/`current` 软链、不重启应用、不动 80 端口与原网站、不动 iOS、不做 git 操作。

执行依据：`deploy/README.md` §8（证书存储迁移与安全回滚）+ 本仓库已审查的 `deploy/prepare-caddy-migration.mjs`。

**✅ 当前状态（2026-09-28 03:04 CST）：迁移已执行完成。** Caddy active/running，新 PID **345566**，`XDG_DATA_HOME=/var/lib/caddy-super-error-log`；证书指纹与有效期不变；匿名 401；应用 PID 328766、原网站 PID 16022 不变。残留一条迁移前已存在的 autosave 报错（未修，见末节）。下方 §0 各小节为**历史过程记录**（含已失效的"待批准"状态），最新结论以本节与末节为准。

## 0. 执行进展

### 阶段 A — 已完成 ✅（2026-09-28 02:32 CST）

- **维护目录（后续 SSH/scp 会话沿用此路径）：`SEL_MAINT=/root/sel-caddy-maint-846y7v1t`**（mktemp 创建，root:root 0700）
- 仅上传了两个已审查文件到 `/root/sel-caddy-maint-846y7v1t/staged/`（root:root 0644）：
  - `deploy/prepare-caddy-migration.mjs`（7775 B）
  - `deploy/systemd/super-error-log-caddy.service`（1489 B）
- SHA256 校验 `sha256sum -c`：两文件均 **OK**，与 §1.5 基准一致。

### 阶段 B — 已完成 ✅（2026-09-28 02:33 CST）

- `systemd-analyze verify` 候选单元（停机前，只读）：**OK，无告警输出**。
- 前置断言：FragmentPath=`/etc/systemd/system/super-error-log-caddy.service` ✅；DropInPaths 空 ✅；`prepared/` 不存在 ✅。
- 准备器 `--check` 输出：**「前置检查通过；尚未备份、迁移或重启服务。」**
- `--check` 未写任何文件（`prepared/` 仍不存在）✅；服务状态未变（Caddy MainPID 309798 active/running）✅。
- 准备器提示「仍须检查线上 drop-in 与跨用户权限」：drop-in 已证为空；跨用户权限在 preflight 已实测（caddy 不可穿越 `/var/lib/super-error-log`），阶段 E 还会双向复测。

### 待批准执行：阶段 C 起（含停机窗口）

#### 插曲：首次 C–G 会话挂起（2026-09-28 02:36–02:45 CST，零变更）

- 现象：C–G 单会话命令在本地 WorkBuddy SSH 进程中无 TCP socket 空转数分钟，被 Codex 终止；终止发生在任何远端写入/停服之前。
- 恢复诊断（只读）：`ssh -o BatchMode=yes -o ConnectTimeout=10 wikiworldlife-board true` → **PROBE_OK**（<1s 返回，连接能力正常）。
- 服务器只读快照证实**零变更**：
  - `super-error-log-caddy` 仍 active/running，MainPID **309798**（原进程），`Environment=XDG_DATA_HOME=/var/lib/super-error-log/caddy`（旧嵌套值）；
  - 生效单元文件 sha256 `82260dca…46af`，未被替换；FragmentPath 不变、无 drop-in；
  - 维护目录 `/root/sel-caddy-maint-846y7v1t/` 内**只有 `staged/`**——无 `t-stop.txt`、无 `prepared/`（停机与备份从未开始）；
  - 目标 `/var/lib/caddy-super-error-log` 仍不存在；
  - 端口 80=python3(16022)、443=caddy(309798)、3101=app(328766) 不变；匿名健康 401；应用与原网站均 active、PID 不变。
- 结论：可从阶段 C 干净重跑；重跑前置不变（`prepared/` 不存在、目标不存在均满足）。等待 Codex 核查本快照后再批准恢复 C–G。

#### C–G 脚本化（2026-09-28 02:49 CST，待 Codex 读脚本后批准执行）

为避免再次出现长 heredoc 不透明挂起，C–G 已固化为单一脚本：

- 本地：`/tmp/sel-caddy-maint-1nrmklke/caddy-migrate-c-to-g.sh`（0700 私有目录，`bash -n` 通过）
- 远端：`/root/sel-caddy-maint-846y7v1t/caddy-migrate-c-to-g.sh`（root:root 0644，7326 B）
- **SHA256（两端一致，远端 `sha256sum -c` 已 OK）：`4ac6b51d58ff465779c928a3a20c64c475bd61cb832a102344bbcc74a32810a1`**
- 内容 = 本 runbook 阶段 C–G 的已审查命令，外加：`STAGE` 变量 + `trap ERR`（失败时报 `MAINTENANCE-FAILED stage=… rc=… caddy_state=…`，不自动恢复）；停机前前置断言（prepared/目标不存在、FragmentPath、无 drop-in、helper 存在）；全部 openssl `timeout 15`、curl `--max-time`；双向 UID 隔离要求 rc 精确为 1。
- 未改动已审查的 helper 与候选单元；生产 Caddy 仍 active。**脚本尚未执行，停在此等 Codex 读全文后批准。**

### 阶段 C–G — 已执行 ✅（2026-09-28 02:58 CST，Codex 核验脚本哈希 4ac6b51d… 后批准，单次执行）

**停机窗口：`t-stop=2026-09-28 02:58:04` → `t-start=2026-09-28 02:58:05`（约 1 秒）**，全程输出存 `/root/sel-caddy-maint-846y7v1t/run-c-to-g.log`。

- **C 基线+停机**：指纹/有效期/401/三服务 active 断言全过；只停 `super-error-log-caddy`，inactive 断言 + 443 释放断言通过。
- **D 备份**：`prepared/`（0700）产物齐全且 0600：`legacy-xdg.tar`（30720 B，含 `./caddy/certificates/` 与 `./caddy/acme/` 层）、`previous.service`（仅对照，永不装回）、`next.service`、`rollback.service`、`manifest.json`（`ready: true`）；两候选单元 `systemd-analyze verify` 通过。
- **E 迁移**：目标 `/var/lib/caddy-super-error-log` 由准备器独占创建（0700）；`diff -qr` 新旧存储**零差异**；嵌套 `caddy/` 层保留；双向 UID 隔离断言精确 rc=1（caddy↛应用目录、supererrorlog↛证书目录）；caddy 对新存储读/写 rc=0。
- **F 单元**：安装 `next.service`（root:root 0644）→ daemon-reload → 只启动本 Caddy。
- **G 验收**：⚠️ **脚本原运行于 G 证据采集步以 rc=1 退出**（`journalctl --since` 不识别 ISO 格式），未在脚本内跑完；下列各项由后续只读补采逐项完成，并经 Codex 独立复核确认：
  - 新进程 PID **345566**，`Environment=XDG_DATA_HOME=/var/lib/caddy-super-error-log`，ReadWritePaths 同步；active/running。
  - 实时 TLS 指纹**不变** `69:E6:40:DF:…:92:D4`，有效期不变（notAfter=Dec 17 13:41:49 2026 GMT）；磁盘证书指纹与实时一致（Codex 独立复核确认指纹不变）。
  - 公网匿名健康 **401**（curl 无 insecure 标志，TLS 校验全程启用）；应用 loopback 401。
  - 应用 MainPID **328766** 与原网站 MainPID **16022** 与停机前基线逐值相等（Codex 独立复核确认）；80/443/3101 端口归属不变；原网站 active。
  - UID 隔离断言：caddy→应用目录、supererrorlog→证书目录的 deny 均为精确 rc=1，caddy 对新存储读/写 rc=0（Codex 独立复核确认）。
  - 启动后日志（`journal-post-start.log`）：存储路径 `FileStorage:/var/lib/caddy-super-error-log/caddy` 生效；**02:58:07 观察到 `updated and stored ACME renewal information`（ari_unique_id 与此前每 10 分钟报错的锁文件同名）——此前持续失败的 ARI 维护写入现已成功**。存储路径 **零** permission denied。
- **诚实边界**：实际换发新证书未发生。ARI 窗口（日志 epoch 换算，+08）：window_start=1794846354=**2026-11-17 00:25:54**，window_end=1795001804=**2026-11-18 19:36:44**；证书到期 2026-12-17 21:41:49（+08）。本报告**不宣称续期已证明**，仅证明维护通道（锁+ARI 写入）已恢复。
- **既有报错（未修，不宣称无害）**：日志存在 `unable to create folder for config autosave: mkdir /home/caddy: permission denied`（XDG_CONFIG_HOME autosave）。经溯源与 Codex 独立核实：同一报错由旧 PID 309798 在 **Sep 18 22:40:09** 已记录——是迁移前就存在的既有报错，非本次引入；但其影响未证明无害，本次维护未处理。本脚本初版 blanket grep 曾把它判为失败——证据补采时已按路径分类单列。

### 终验补采（2026-09-28 03:01 CST，Codex 独立复核后，全只读）

- G 全量日志已用 `--since "2026-09-28 02:58:04"`（systemd 239 兼容格式）重采并私有保存：`journal-since-stop.log`（28 行，含停/启全序列）、`journal-post-start.log`、`journal-pre-migration.log`（Sep 18–停机前全量）。
- **autosave 报错溯源：先于迁移存在。** 迁移前日志中同一报错出现于 **Sep 18 22:40:09**（旧单元时代首次启动、旧 PID 309798，1 次，Codex 独立核实）；迁移后 02:58:05 再出现 1 次——非本次引入的既有报错。原因观察：caddy 用户 passwd home=`/home/caddy` 不存在且不可建，Caddy 的 config autosave（XDG_CONFIG_HOME）落盘失败。**其影响范围未证明无害，本报告不作此断言；本次维护未处理它。**
- **迁移成效与 autosave 报错分开陈述**：①迁移 + ARI 维护通道恢复 = 成功（存储路径零拒绝、02:58:07 ARI 写入成功）；②autosave 报错 = 迁移前已存在的既有问题，本次未修。不宣称「日志完全干净」；不宣称续期已证明（ARI 窗口 2026-11-17 00:25:54 → 11-18 19:36:44 +08，尚未开启）。
- **最小后续建议（仅提议，未执行，需另行批准）**：(a) 保持现状并继续观察该报错（其性质未定性，观察后续启动/日志）；(b) 在下次获准窗口创建 `/home/caddy`（caddy:caddy 0700）或在单元中加 `Environment=XDG_CONFIG_HOME=/var/lib/caddy-super-error-log/.config` 使 autosave 可写。两者都是独立小变更，不属于本次维护范围。
- **保留物（不清理）**：旧存储 `/var/lib/super-error-log/caddy` 原样未动（mtime 仍 Sep 18）；`/root/sel-caddy-maint-846y7v1t/` 全部证据与备份（prepared/、run 日志、双日志、基线、终态）。
- 执行中教训：systemd 239 的 `journalctl --since` 不接受 `T…+08:00` ISO 格式，需 `YYYY-MM-DD HH:MM:SS`；脚本证据步的首次失败即因此（rc=1 时迁移本身已全部成功，trap 正确报告了 stage=G-verify、caddy_state=active）。

**维护闭环：迁移完成并处于目标状态（Caddy 新存储、指纹不变、401、PID 不变）；遗留一条迁移前已存在的 autosave 报错未修（见上）。停在此等 Codex/用户终验。旧存储与备份按 runbook 阶段 H 保留，不删除。**

---

## 1. 只读 Preflight 结果（2026-09-27 16:03 CST，迁移前历史快照，经 SSH alias `wikiworldlife-board`，全部只读）

### 1.1 服务状态

| 项 | 观测值 | 判定 |
|---|---|---|
| `super-error-log-caddy` | active/running，MainPID **309798**（2026-09-18 22:40 起） | 正常 |
| FragmentPath | `/etc/systemd/system/super-error-log-caddy.service` | 如预期 |
| DropInPaths | **空** | 无 drop-in，符合 §8.1 前置 |
| 生效单元内容 | `User/Group=caddy`、`Environment=XDG_DATA_HOME=/var/lib/super-error-log/caddy`、`ReadWritePaths=/var/lib/super-error-log/caddy`、`NoNewPrivileges=true`、`AmbientCapabilities=CAP_NET_BIND_SERVICE`、ExecStart=`/usr/local/bin/caddy run --config /opt/super-error-log/current/deploy/caddy/Caddyfile`、无 EnvironmentFile | 与准备器 `safeRollback` 的旧单元约束逐条匹配 |
| `super-error-log`（应用） | active/running，MainPID **328766** | 本次不动 |
| `wikiworldlife-board`（原网站） | active/running，MainPID **16022** | 本次不动 |
| 端口 | 80=python3(16022)、443=caddy(309798)、127.0.0.1:3101=app(328766) | 如预期 |

### 1.2 存储树元数据（仅元数据，未读私钥内容）

- `/var/lib/super-error-log`：`supererrorlog:supererrorlog 0700`（应用私有，caddy **不可穿越**，已实测 `runuser -u caddy -- test -x` 失败 = 预期良好）
- `/var/lib/super-error-log/caddy`（旧 XDG 根）：`caddy:caddy 0700`
- 其下 `caddy/`（实际存储）：`caddy:caddy 0700`，含：
  - `certificates/acme-v02.api.letsencrypt.org-directory/study.pccoding666.com/`（.crt/.key/.json，0600 caddy:caddy）
  - `acme/acme-v02.api.letsencrypt.org-directory/users/default/`（default.json/default.key，0600）
  - `acme/.../challenge_tokens/`（空目录）、`locks/`（空目录）、`instance.uuid`、`last_clean.json`
- 树内仅普通文件与目录（`find` 输出仅 `d`/`f` 类型），**无符号链接/特殊文件**，满足准备器 `checkTree` 前置
- 目标 `/var/lib/caddy-super-error-log`：**不存在**（§8 要求，满足）
- `caddy` 用户：uid=994 gid=991，附加组 supererrorlog
- Caddy v2.10.0；Node v24.21.0（`/opt/super-error-log/node-v24/bin/node`）
- 磁盘：`/` 余量 31G，充足

### 1.3 证书与访问面基线（迁移后必须逐项回对）

- 实时 TLS（127.0.0.1:443，SNI study.pccoding666.com）：
  - subject `CN=study.pccoding666.com`，issuer `Let's Encrypt YE2`
  - 有效期 `notBefore=Sep 18 13:41:50 2026 GMT` → `notAfter=Dec 17 13:41:49 2026 GMT`
  - **SHA256 指纹 `69:E6:40:DF:76:56:E2:DC:2D:8F:3C:6D:4B:A7:17:FA:A1:41:5F:80:A6:E5:3D:03:E1:35:89:16:CB:04:92:D4`**
- 匿名 `https://study.pccoding666.com/v1/health` → **401**；应用 loopback `http://127.0.0.1:3101/v1/health` → **401**

### 1.4 故障证据（本次维护的根因）

journal（近 7 天）显示 `tls.cache.maintenance` 每 10 分钟报：
`updating ARI … unable to obtain ARI lock: creating lock file: open /var/lib/super-error-log/caddy/caddy/locks/ari_….lock: permission denied`（最新一条 16:00:09，持续中）。

根因符合 README §1 记载的踩坑：旧 XDG 嵌在应用会强制 0700 的 `/var/lib/super-error-log` 内，caddy 用户无法穿越父目录写锁文件 → ARI 续期维护持续失败，需修复。

### 1.5 关键差异：当前线上发布物不含迁移辅助物

`current → releases/0.1.1-manual-release`，其中**没有** `deploy/prepare-caddy-migration.mjs`，也没有 `deploy/systemd/super-error-log-caddy.service`（仅有应用单元）。

→ 因此按用户指令：**只把本仓库已审查的辅助脚本 + 候选单元两个文件**暂存进服务器上一个新的私有维护目录，SHA256 校验通过后才可作为准备器的 `--release` 输入。本地上传内容的基准哈希：

```
b1d8a8a315cd704f08ec4e95e5cb27193e77c0fb71727089b2fd70eb80c91de3  deploy/prepare-caddy-migration.mjs
bf89e031587d7f53435839f09631b8bdaa0136e46658a2eafe5fff208462ceda  deploy/systemd/super-error-log-caddy.service
```

本地候选单元已人工对照准备器 `validateCandidate` 约束：User/Group=caddy、单一 `Environment=XDG_DATA_HOME=/var/lib/caddy-super-error-log`、单一 `ReadWritePaths=/var/lib/caddy-super-error-log`、NoNewPrivileges=true、ExecStart 精确匹配、无 EnvironmentFile —— 可通过校验。候选单元只改存储路径与用户约束无关项，不动 Caddyfile 引用。

---

## 2. 执行计划（待 Codex 审阅批准后，root 分段执行；任一步失败即停，不续做）

约定：全程 `set -euo pipefail`；所有远端写入只发生在新建的 `/root/sel-caddy-maint-XXXXXXXX` 私有目录与最终目标目录；禁止 chmod 777、禁止 root 跑 Caddy、禁止跳过 TLS 校验、禁止装回旧单元、禁止删除旧存储/备份。

### 阶段 A — 暂存与哈希校验（远端写入仅限新建私有目录）

```bash
set -euo pipefail
SEL_MAINT="$(mktemp -d /root/sel-caddy-maint-XXXXXXXX)"; echo "$SEL_MAINT"  # mktemp 即 0700
install -d -m 0700 "$SEL_MAINT/staged/deploy/systemd"
```

本地（macOS）上传两个已审查文件：

```bash
scp deploy/prepare-caddy-migration.mjs \
  wikiworldlife-board:"$SEL_MAINT/staged/deploy/"
scp deploy/systemd/super-error-log-caddy.service \
  wikiworldlife-board:"$SEL_MAINT/staged/deploy/systemd/"
```

服务器上校验（哈希必须与 §1.5 基准一致，不一致即停止并调查）：

```bash
cd "$SEL_MAINT/staged"
sha256sum -c - <<'SUMS'
b1d8a8a315cd704f08ec4e95e5cb27193e77c0fb71727089b2fd70eb80c91de3  deploy/prepare-caddy-migration.mjs
bf89e031587d7f53435839f09631b8bdaa0136e46658a2eafe5fff208462ceda  deploy/systemd/super-error-log-caddy.service
SUMS
```

### 阶段 B — 准备器 `--check`（不写任何文件）

```bash
export PATH=/opt/super-error-log/node-v24/bin:$PATH
SEL_OLD_CADDY_UNIT="$(systemctl show super-error-log-caddy -p FragmentPath --value)"
test "$SEL_OLD_CADDY_UNIT" = /etc/systemd/system/super-error-log-caddy.service
test -z "$(systemctl show super-error-log-caddy -p DropInPaths --value)"
SEL_CADDY_PREP="$SEL_MAINT/prepared"
node "$SEL_MAINT/staged/deploy/prepare-caddy-migration.mjs" \
  --release "$SEL_MAINT/staged" --current-unit "$SEL_OLD_CADDY_UNIT" \
  --legacy-xdg /var/lib/super-error-log/caddy --staging "$SEL_CADDY_PREP" --check
# 期望输出：前置检查通过；尚未备份、迁移或重启服务。

# 停机前先静态校验候选单元（只读，不安装）
systemd-analyze verify "$SEL_MAINT/staged/deploy/systemd/super-error-log-caddy.service"
```

### 阶段 C — 记录基线并只停本 Caddy

```bash
date -Is | tee "$SEL_MAINT/t-stop.txt"
# 基线留档（人读；openssl 有界 15s，空证书输出即失败）
{ base_tls="$(echo | timeout 15 openssl s_client -connect 127.0.0.1:443 -servername study.pccoding666.com 2>/dev/null \
      | openssl x509 -noout -subject -issuer -dates -fingerprint -sha256)"
  test -n "$base_tls"; printf '%s\n' "$base_tls"
  ss -ltnp | grep -E ':(80|443|3101)[[:space:]]'
} | tee "$SEL_MAINT/baseline.txt"
# 基线硬断言：公网 TLS 健康必须 401（curl 不带任何 -k/--insecure）
base_code="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' https://study.pccoding666.com/v1/health)"
test "$base_code" = 401
# 停机窗口前三服务必须全部 active（本 Caddy / 应用 / 原网站）
for u in super-error-log-caddy super-error-log wikiworldlife-board; do
  s="$(systemctl is-active "$u" || true)"
  test "$s" = active || { echo "$u 基线状态异常: $s" >&2; exit 1; }
done
# 机读基线供阶段 G 断言
systemctl show super-error-log -p MainPID --value > "$SEL_MAINT/baseline.app.pid"
systemctl show wikiworldlife-board -p MainPID --value > "$SEL_MAINT/baseline.web.pid"

systemctl stop super-error-log-caddy
# is-active 对 inactive 返回非零属正常信号；显式断言：仅 inactive 通过，其他任何状态（含 failed/unknown/active）一律失败
caddy_state="$(systemctl is-active super-error-log-caddy || true)"
test "$caddy_state" = inactive || { echo "停止后状态异常: $caddy_state" >&2; exit 1; }
# 不用管道遮蔽 ss 自身失败：先取全量输出（ss 失败会被 set -e 捕获），再做字符串断言
listeners="$(ss -ltnp)"
case "$listeners" in *':443 '*) echo '443 仍在监听，停止未生效' >&2; exit 1;; esac
```

注：停 Caddy 期间 `study.pccoding666.com` 外网入口短暂不可用；应用 loopback 与原网站 80 不受影响。窗口预计数分钟。

### 阶段 D — 停服后一致备份 + 生成单元候选（准备器正式运行）

```bash
node "$SEL_MAINT/staged/deploy/prepare-caddy-migration.mjs" \
  --release "$SEL_MAINT/staged" --current-unit "$SEL_OLD_CADDY_UNIT" \
  --legacy-xdg /var/lib/super-error-log/caddy --staging "$SEL_CADDY_PREP"
# 产物（全在 $SEL_CADDY_PREP，0600）：previous.service（仅对照，永不装回）、
#   next.service、rollback.service、legacy-xdg.tar（整份 XDG 根，含 caddy/ 层）、manifest.json
grep -q '"ready": true' "$SEL_CADDY_PREP/manifest.json"   # 文件输入，无管道
systemd-analyze verify "$SEL_CADDY_PREP/next.service"
systemd-analyze verify "$SEL_CADDY_PREP/rollback.service"
# 不落 grep -q 管道（grep 提前退出会让 tar 吃 SIGPIPE、pipefail 误判失败）：先全量落盘再查
tar -tf "$SEL_CADDY_PREP/legacy-xdg.tar" > "$SEL_MAINT/archive.list"
grep -q '^\./caddy/certificates/' "$SEL_MAINT/archive.list"   # 归档含证书层
```

### 阶段 E — 独占创建目标并迁移数据

```bash
node "$SEL_MAINT/staged/deploy/prepare-caddy-migration.mjs" \
  --create-private-destination /var/lib/caddy-super-error-log
# 准备器以非递归 mkdir 独占创建 0700；已存在即失败（preflight 已确认不存在）
tar -xpf "$SEL_CADDY_PREP/legacy-xdg.tar" -C /var/lib/caddy-super-error-log
chown -R caddy:caddy /var/lib/caddy-super-error-log
chmod 0700 /var/lib/caddy-super-error-log
diff -qr /var/lib/super-error-log/caddy /var/lib/caddy-super-error-log   # 期望无输出（等价）
test -d /var/lib/caddy-super-error-log/caddy                            # 保留嵌套 caddy/ 层
# 读写检查：runuser 必须成功（rc=0）
rc=0; runuser -u caddy -- test -r /var/lib/caddy-super-error-log/caddy || rc=$?
test "$rc" -eq 0 || { echo "caddy 不可读新存储 rc=$rc" >&2; exit 1; }
rc=0; runuser -u caddy -- test -w /var/lib/caddy-super-error-log/caddy || rc=$?
test "$rc" -eq 0 || { echo "caddy 不可写新存储 rc=$rc" >&2; exit 1; }
# UID 隔离：先确认两用户存在（runuser 自身失败不算隔离证据），拒绝必须精确 rc=1（test 的「否」）
id caddy
id supererrorlog
rc=0; runuser -u caddy -- test -x /var/lib/super-error-log || rc=$?
test "$rc" -eq 1 || { echo "caddy→应用目录拒绝检查无定论 rc=$rc（必须精确 1）" >&2; exit 1; }
rc=0; runuser -u supererrorlog -- test -x /var/lib/caddy-super-error-log || rc=$?
test "$rc" -eq 1 || { echo "supererrorlog→证书目录拒绝检查无定论 rc=$rc（必须精确 1）" >&2; exit 1; }
```

### 阶段 F — 安装已审查单元并只启动本 Caddy

```bash
install -o root -g root -m 0644 "$SEL_CADDY_PREP/next.service" /etc/systemd/system/super-error-log-caddy.service
systemctl daemon-reload
systemctl start super-error-log-caddy
systemctl show super-error-log-caddy -p ActiveState,SubState,MainPID,Environment,ReadWritePaths
# 期望 active/running，Environment=XDG_DATA_HOME=/var/lib/caddy-super-error-log
```

### 阶段 G — 验收（全部只读，逐项对照 §1.3 基线）

```bash
# 1) 标准 TLS 握手，指纹逐字节断言（不跳过证书校验；timeout 15s，超时即失败）
fp="$(echo | timeout 15 openssl s_client -connect 127.0.0.1:443 -servername study.pccoding666.com 2>/dev/null \
      | openssl x509 -noout -fingerprint -sha256)"
test "$fp" = 'SHA256 Fingerprint=69:E6:40:DF:76:56:E2:DC:2D:8F:3C:6D:4B:A7:17:FA:A1:41:5F:80:A6:E5:3D:03:E1:35:89:16:CB:04:92:D4'
tls_dates="$(echo | timeout 15 openssl s_client -connect 127.0.0.1:443 -servername study.pccoding666.com 2>/dev/null \
      | openssl x509 -noout -dates)"
case "$tls_dates" in *'notAfter=Dec 17 13:41:49 2026 GMT'*) : ;; *) echo "证书有效期已变化: $tls_dates" >&2; exit 1;; esac
# 2) 磁盘证书与实时一致（公钥证书可比对；不读 .key）
disk_fp="$(openssl x509 -in /var/lib/caddy-super-error-log/caddy/certificates/acme-v02.api.letsencrypt.org-directory/study.pccoding666.com/study.pccoding666.com.crt \
  -noout -fingerprint -sha256)"
test "$disk_fp" = "$fp"
# 3) 匿名健康 401 / 应用 loopback 401（--max-time 有界，curl 失败即中止）
code="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' https://study.pccoding666.com/v1/health)"
test "$code" = 401
code="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3101/v1/health)"
test "$code" = 401
# 4) 应用与原网站未受影响（与停机前机读基线逐值断言）
test "$(systemctl show super-error-log -p MainPID --value)" = "$(cat "$SEL_MAINT/baseline.app.pid")"
test "$(systemctl show wikiworldlife-board -p MainPID --value)" = "$(cat "$SEL_MAINT/baseline.web.pid")"
web_state="$(systemctl is-active wikiworldlife-board || true)"
test "$web_state" = active
listeners="$(ss -ltnp)"   # 人工核对：80=原网站、443=caddy、127.0.0.1:3101=app，归属与基线一致
# 5) 启动后日志全量人工检查（自 $SEL_MAINT/t-stop.txt 时间起；不做 grep -q 管道）
journalctl -u super-error-log-caddy --since "$(cat "$SEL_MAINT/t-stop.txt")" --no-pager
#    期望：加载现有证书、无 permission denied、无重新走 ACME 签发的报错
```

**诚实性约束**：一次成功启动 + 无报错 ≠ 续期维护已证明通过。若观察窗口内未发生实际 ARI/续期动作，在验收记录中保留「证书维护待观察」项（ARI  tick 约每 10 分钟一次，至少覆盖 2 个周期再下结论），不强制续签、不宣称已续期。

### 阶段 H — 保留与禁止项

- 保留：旧存储 `/var/lib/super-error-log/caddy`（原样不动）、`$SEL_MAINT`（含 legacy-xdg.tar 备份与全部单元，0600/0700，永不上传 Git/公网）。
- 不做任何清理删除；不做应用重启/切链；不动 80/原网站；不动 iOS；无 git 操作。

## 3. 回滚（仅在新单元故障时；沿用独立存储，永不装回 previous.service）

```bash
systemctl stop super-error-log-caddy
install -o root -g root -m 0644 "$SEL_CADDY_PREP/rollback.service" /etc/systemd/system/super-error-log-caddy.service
systemctl daemon-reload && systemctl start super-error-log-caddy
# 回滚单元保留原运行参数，但 XDG/ReadWritePaths 固定到新独立目录 /var/lib/caddy-super-error-log
```

若失败发生在阶段 E 完成之前：保持 Caddy 停止，把 `legacy-xdg.tar` 恢复到**新的空独立目录**（不覆盖半份目标），重做完好性/权限检查后再挂 rollback 单元启动。无可用可验证备份时停止自动恢复、交运维。

---

**STOP**：阶段 A+B 已完成且全部只读/零服务影响。等待用户最终审阅批准后才进入阶段 C（首个含停机与生产的阶段）。
