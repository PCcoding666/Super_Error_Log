# GitHub 自动发布

## 日常使用

1. Codex Cloud 从 `main` 新建分支，修改后提 PR 到同一个集成分支。
2. PR 的 CI 通过后，检查修改并合并。
3. 合并提交再跑一遍 CI。全部必需任务通过后，`production / release` 自动发布到 https://study.pccoding666.com/s/ 。通常检查约 4 分钟，发布约 1–3 分钟，以 Actions 实际记录为准。
4. Actions 摘要显示上线提交和版本。失败时查看失败任务；启动检查失败会自动恢复旧版本。GitHub 的失败通知沿用你的账户通知设置。

普通 PR 不使用生产密钥。`main` 是唯一默认、开发汇总与发布分支；旧集成分支已退役。合并后删除任务分支，历史仍保留在 PR 和 Git 提交中。详见 [分支说明](../../docs/BRANCHES.md)。

## 仓库配置

Environment：`production`，只允许 branch `main`。

| 名称 | 类型 | 含义 |
| --- | --- | --- |
| `SEL_DEPLOY_HOST` | environment variable | ECS 地址（不含协议） |
| `SEL_DEPLOY_SSH_KEY` | environment secret | 专用 `sel-deploy` 私钥；不能用管理员私钥替代 |
| `SEL_DEPLOY_KNOWN_HOSTS` | environment secret | 从已信任的管理员连接读取、核对过的 SSH 主机公钥；不要用未核验的 ssh-keyscan 覆盖 |

生产 AI 密钥、邀请码、学生会话、照片和数据库始终留在服务器。Actions 只保存白名单发布包和合成测试失败报告。

`.github/workflows/ci.yml` 负责检查，成功后调用 `deploy.yml`。生产分支运行不取消正在执行的旧发布，服务器还另有发布锁。提交前检查当前分支 SHA，过时的运行跳过。已经开始的发布会完成，随后由新运行发布新版本。

不设置第二个公开发布入口或长期 self-hosted runner。工作流文件和发布程序属于敏感改动，需要人工 review；分支保护至少要求现有 `server (typecheck, build, vitest, playwright)` 检查。

## 服务器初次配置（管理员）

根路径 `/opt/super-error-log`、数据 `/var/lib/super-error-log`、Node 24 `/opt/super-error-log/node-v24/bin`，沿用现有 `super-error-log.service`。本方案面向 systemd 239、Python 3.6+。

- `sel-deploy`：SSH 专用账号，home `/var/lib/sel-deploy`；home、`.ssh` 和 `authorized_keys` 都归 root，账号不能改自己的授权规则。shell `/bin/sh` 仅用于执行固定入口。
- `sel-build`：无登录独立账号；缓存 `/var/cache/sel-build`，不能读取学生数据。生产 `npm ci --omit=dev --ignore-scripts` 以此账号运行；不执行依赖安装脚本。如果未来依赖确实需要安装脚本，应重新审查构建方案，不能去掉这道限制。
- 安装本目录 `ssh-entry.sh` 到 `/usr/local/sbin/sel-ci-ssh`（root:root 0755）。
- 安装 `sel-ci-deploy.py` 到 `/usr/local/sbin/sel-ci-deploy`（root:root 0755）。运行中的程序始终是管理员安装的固定副本，不会从发布包自行升级。
- `authorized_keys` 只追加这个发布专用公钥，前缀：`restrict,command="/usr/local/sbin/sel-ci-ssh"`。
- sudoers 单独文件：`sel-deploy ALL=(root) NOPASSWD: /usr/local/sbin/sel-ci-deploy`，用 `visudo -cf` 检查。该程序严格校验参数，只提供提交/查状态；不要授予任意 sudo 命令。
- `/var/lib/sel-ci` 和 `/var/backups/super-error-log-ci` 为 root:root 0700。

初次安装后，以专用密钥确认普通 `id` 命令被拒绝。变更受限发布程序时，要重新 review，并由管理员安装固定副本；不能仅合并 PR 就期待服务器发布程序自动变化。

## 发布过程与中断

`publish.sh` 上传包并核对 SHA256，服务端检查路径、白名单、类型、展开大小、提交 SHA 和运行 ID。单独的 systemd 临时单元负责发布，关闭电脑或 GitHub 连接断开不会中断服务器事务。

顺序：清理旧备份/旧版本（只留最近 3 份）→ 安装生产依赖 → 等待照片识别/打印空闲（最多 2 分钟）→ 确认旧服务健康 → **服务仍在运行时打包照片等文件**（`files.tar`，不压缩、不含 SQLite）→ 停服务并再次检查是否有新任务 → 只打包 SQLite 与 WAL（`sqlite.tar`，通常几秒）→ 原子切换 `current` → 启动 → HTTPS 登录页、JS/CSS、匿名 API 拒绝检查。停服时间只覆盖 SQLite 打包和重启，用户正在提交表单时可能需要重试。北京时间 18:00–24:00 `deploy.yml` 不发布（发布窗口，见 `docs/quality/RELEASE_CHECKLIST.md`）。

服务器任务最多 15 分钟，命令也有各自超时；超时尝试恢复旧服务。状态保存在 `/var/lib/sel-ci/<run-id>-<attempt>/status.json`。Actions 或网络中断后，先查询它，不要连续重启或反复上传：

```sh
ssh sel-deploy@SERVER 'status RUN_ID-ATTEMPT'
```

账号只允许这条命令和校验后的 `submit`，不提供 shell/SFTP/端口转发。查询不返回学生内容或密钥。

## 失败与恢复

- CI 失败：不上线，修好后重新提交。
- 队列 2 分钟未空闲、磁盘不足 2 GiB、依赖安装失败：旧服务继续运行。稍后在 Actions 点 **Re-run failed jobs**；重新运行会使用新的 attempt ID。
- 新版启动检查失败：自动切回上一版本并检查旧服务；Actions 仍显示失败，不把回退误报成发布成功。
- 如果状态是 `rollback: failed`，管理员检查 `systemctl status super-error-log`，读取私有 `failure.log`；不要把整个服务日志粘贴到公开 issue。
- 必须人工回退一个已上线但有业务问题的版本时，管理员确认没有在跑的发布，再把 `current` 指向状态里的 `previous` 并重启。之后用 revert PR 修复集成分支，防止下次又部署问题代码。

备份在 `/var/backups/super-error-log-ci/<run-id>-<attempt>/`：`files.tar`（照片等文件，停服前打包）、`sqlite.tar`（SQLite/WAL 与 systemd 单元，停服后打包），仅 root 可读。**不含 env 文件和 TLS 私钥**（`env`、`*.env`、`*.pem`、`*.key`、`tls*/` 都被排除）。恢复时先停服务，依次 `tar -xf files.tar -C /`、`tar -xf sqlite.tar -C /`。**代码回退不自动恢复数据库**：避免覆盖用户新写入；数据恢复必须另行确认。发布程序比较 `dist/db/` 和 `dist/studentHost/registry.js`，这些已知迁移入口变更时自动发布会提前拒绝，须安排人工发布和迁移验收。禁止把迁移藏在其他入口绕过检查；代码审查仍是必要边界。

每次发布开始时自动只保留最近 3 份发布备份（只删名字是 `<run-id>-<attempt>` 的真实目录，不跟随软链）和最近 3 个 `releases/ci-*`（当前版本永远保留；非 `ci-` 的人工版本不动）。低于 2 GiB 拒绝新发布。此机备份只能覆盖误发布/误操作，不能代替异地备份：每日异地备份见 `deploy/ops/RUNBOOK.md`。改了本程序后要由管理员重新安装 `/usr/local/sbin/sel-ci-deploy`（RUNBOOK 第 7 步）。

## 验收范围

启动冒烟检查不创建学生、不调用真实 AI、不改学习数据，也不能证明所有学生流程/识别准确率；完整逻辑由 CI 合成测试覆盖，真实使用体验仍靠真机验收。每次发布的 Actions 摘要与服务器状态共同记录实际部署结果。
