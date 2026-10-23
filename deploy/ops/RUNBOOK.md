# 错题本运维一页纸（Peng 本人 SSH 执行）

> **状态（2026-10-22）**：本目录的脚本和定时器只在本地合成数据上测试过（`tests/unit/opsScripts.test.ts`、`tests/deploy/`），**没有在生产服务器上运行过**。第一次在服务器上执行时，每一步先加 `--dry-run` 看输出，再真跑。下面所有命令都以 root 执行，除非写了 `runuser`。看 Markdown 源文件时，表格里的 `\|` 输入为 `|`。

## 一、Day 0（上线给学生前一次性做完，约半天）

| # | 做什么 | 命令 / 页面 |
|---|---|---|
| 1 | 固定的管理命令包装，以后所有 `sel-admin` 都走它（防止少一个环境变量建出空库） | `printf '%s\n' '#!/bin/sh' 'exec runuser -u supererrorlog -- env SEL_STUDENT_HOST_DIR=/var/lib/super-error-log/student-host /opt/super-error-log/node-v24/bin/node /opt/super-error-log/current/dist/studentHost/admin-cli.js "$@"' > /usr/local/sbin/sel-admin && chmod 0750 /usr/local/sbin/sel-admin` |
| 2 | 初始化后台口令 | `sel-admin admin-password` → 存密码管理器 → 打开 `https://study.pccoding666.com/admin/` |
| 3 | 核对容量配置（只看非密钥项） | `grep -E '^SEL_(MAX_LIVE_WORKERS\|GLOBAL_AI_CONCURRENCY\|GLOBAL_IMAGE_CONCURRENCY\|RSS_ADMISSION_MIB\|SERVICE_MEMORY_MIB\|MAX_STUDENTS\|WORKER_IDLE_MS\|STUDENT_HOST_ENABLED\|STUDENT_HOST_DIR\|AI_FALLBACK_DAILY_CALLS\|AI_FALLBACK_DAILY_TOKENS)=' /etc/super-error-log/env` |
| 4 | 时区与日志占用 | `timedatectl \| grep 'Time zone'`（期望 Asia/Shanghai）；`journalctl --disk-usage`；建议 `/etc/systemd/journald.conf` 设 `SystemMaxUse=500M` 后 `systemctl restart systemd-journald` |
| 5 | 看盘 | `df -h /`；`du -sh /var/backups/super-error-log-ci /opt/super-error-log/releases /var/lib/super-error-log` |
| 6 | **清理旧发布备份（删除操作，你确认后再执行）**。旧包里有 env 密钥和证书私钥，只留最近 3 份 | 先看：`ls -1dt /var/backups/super-error-log-ci/*/ \| tail -n +4`；确认列表无误后：`ls -1dt /var/backups/super-error-log-ci/*/ \| tail -n +4 \| xargs -r rm -rf --` |
| 7 | **重新安装发布程序**（本 PR 合并且自动发布成功后；服务器只运行管理员安装的固定副本，不会自动更新） | `diff /usr/local/sbin/sel-ci-deploy /opt/super-error-log/current/deploy/ci/sel-ci-deploy.py`；看过后 `install -m 0755 -o root -g root /opt/super-error-log/current/deploy/ci/sel-ci-deploy.py /usr/local/sbin/sel-ci-deploy`。之后每次发布：先在服务运行时打包照片 → 停服 → 只打包 SQLite（几秒）→ 启动；不再带 env 和私钥；自动只留 3 份备份、3 个旧 ci 版本 |
| 8 | 阿里云控制台 | ① 云盘「自动快照策略」：每天 03:30、保留 7 天，绑定系统盘；② 云监控「站点监控」HTTPS GET `https://study.pccoding666.com/s/` 关键字「邀请码」，多个国内探测点，连续 2 次失败报警；主机监控磁盘 > 80%、内存 > 90%；③ 费用中心「预算/费用预警」按量日消费上限；④ 百炼控制台确认 Token Plan 用途条款、按量接口的消费上限 |
| 9 | AI 按量付费熔断（应用内） | 在 `/etc/super-error-log/env` 加 `SEL_AI_FALLBACK_DAILY_CALLS=200`、`SEL_AI_FALLBACK_DAILY_TOKENS=2000000`（缺省就是这两个值；`0` = 完全不用备用）。改完要重启服务：`systemctl restart super-error-log`。效果看 `/admin/` →「调用性能 → 按调用线路」 |
| 10 | 安装运维脚本与定时器 | `bash /opt/super-error-log/current/deploy/ops/install.sh --dry-run` → 看计划 → `bash /opt/super-error-log/current/deploy/ops/install.sh`（先不启用定时器） |
| 11 | 异地备份目标（二选一） | **OSS**：开同地域私有桶，服务端加密，生命周期规则 14 天删除；建 RAM 子账号只给该桶前缀写权限；装 ossutil 到 `/usr/local/bin/ossutil`，以 root `ossutil config` 写入子账号 AK（存在 `/root/.ossutilconfig`，不放 env）；`ops.env` 写 `SEL_BACKUP_REMOTE=oss://<桶>/super-error-log`。**另一台主机**：`dnf install -y rsync`；root 生成专用密钥，对方 `authorized_keys` 限制该 key；`SEL_BACKUP_REMOTE=rsync:backup@<主机>:/srv/sel-backup` |
| 12 | 推送 key | `/etc/super-error-log/alert.env`（0600）写 `SEL_ALERT_BARK_KEY=…` 或 `SEL_ALERT_WECOM_WEBHOOK=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…` |
| 13 | 第一次手动跑 | 备份：`systemctl start sel-backup.service; journalctl -u sel-backup -n 30 --no-pager`（期望 `backup_ok` 和 `push_ok`；`ls /var/backups/super-error-log-daily/`）。巡检先演练：`set -a; . /etc/super-error-log/ops.env; . /etc/super-error-log/alert.env; set +a; /opt/super-error-log/node-v24/bin/node /usr/local/lib/sel-ops/sel-healthcheck.mjs check --dry-run`；再真发一次日报确认手机收得到：`systemctl start sel-daily-report.service` |
| 14 | 恢复演练（必须做一次，记下用时） | `runuser -u supererrorlog -- /opt/super-error-log/node-v24/bin/node /usr/local/lib/sel-ops/sel-restore.mjs --from /var/backups/super-error-log-daily/$(date +%F) --target /var/tmp/sel-drill-$(date +%s)`（期望 `restore_ok`、`errorItems` 与后台错题数一致；看完删掉 `/var/tmp/sel-drill-*`）。从 OSS 演练：`ossutil cp -r oss://<桶>/super-error-log/<日期>/ /root/drill-<日期>/` 再用 `--from` 指向它 |
| 15 | 启用定时器 | `systemctl enable --now sel-backup.timer sel-healthcheck.timer sel-daily-report.timer`；`systemctl list-timers 'sel-*'` |
| 16 | 首批规模 | 首批 ≤ 8 人；你预先 `sel-admin create` 发码给老师，不让全班当场注册；错峰使用 |

## 二、出事了怎么办

| 推送里写的 | 先做 |
|---|---|
| 服务没有在运行 / 刚自动重启 | `systemctl status super-error-log`；`journalctl -u super-error-log -n 100 --no-pager \| grep -E 'sel_worker_error\|Error'` |
| 学生进程错误 | `journalctl -u super-error-log --since -30min --no-pager \| grep sel_worker_error`（只有学生 ID 前 8 位，`sel-admin list` 对照） |
| 改走按量付费 N 次 / 备用通道已到上限 | Token Plan 在出问题：看 `/admin/` 按调用线路的失败率；百炼控制台看 Token Plan 额度。确需放宽，改 env 里的两个上限后在窗口内重启；上限到了学生会看到「AI 服务今天有点忙…最晚明天恢复」，照片不丢 |
| AI 失败率高 / 队列积压 | `/admin/` 失败原因；排队多是正常高峰就等；持续 30 分钟不降再查日志 |
| 磁盘只剩 N GiB | `du -sh /var/backups/* /opt/super-error-log/releases /var/lib/super-error-log`；低于 3 GiB 会拒收上传，低于 2 GiB 不能发布 |
| 每日备份失败 / 异地没成功 | `journalctl -u sel-backup -n 50 --no-pager`；`cat /var/backups/super-error-log-daily/last-status.json last-push.json` |
| HTTPS 证书还有 N 天 | `journalctl -u super-error-log-caddy --since -1d \| grep -i renew`（11/16–11/18 是续期窗口，那周每天看一次） |
| 登录页打不开 | 先看服务和 Caddy 是否 active；再从手机流量打开 `https://study.pccoding666.com/s/` |

**真要从备份恢复线上数据**（会覆盖当前数据，先跟老师说好）：在窗口内 `systemctl stop super-error-log` → `sel-restore.mjs --from <快照目录> --target /var/lib/super-error-log --live --confirm-service-stopped`（现有目录会整体改名为 `*.before-restore-<时间>` 保留，不删）→ `systemctl start super-error-log` → 后台核对错题数。env 和证书不在备份里，从密码管理器 / 证书目录恢复。

## 三、每天 / 每周

- 每天：看推送；22:30 日报（注册、AI 调用/失败/耗时、按量备用次数、队列、磁盘、备份）。早上看 `/admin/` 有没有失败要提醒学生重试。
- 每周：做一次第 14 步恢复演练；`df -h /`；看证书到期日和百炼账单；`/admin/` 看 30 天没登录的账号。
- 改了 `deploy/ops/` 或 `deploy/ci/sel-ci-deploy.py` 的 PR 合并后：重新执行第 10 步或第 7 步，服务器才会用上新版本。
