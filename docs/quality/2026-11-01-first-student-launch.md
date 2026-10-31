# 第一个学生上线清单（2026-11-01）

决定（2026-11-01 02:50，用户）：第一个学生先只用「错题本 + AI 解答 + 备注」，练习（隔几天重做、打印、记结果）以后再上。本文是按这个范围整理的上线门槛，逐项写明现状、证据、谁来做。做完一项就在这里打勾并写日期。

线上版本：`releases/ci-41228925952-1`（main 8f89f78 = #85 + #88 + #90 文档），2026-11-01 02:31 自动发布。

## 一、必须先解决的（阻塞）

| # | 事项 | 现状（2026-11-01 02:50） | 谁 |
|---|---|---|---|
| A1 | **AI 解答在线上不生成。** 学生打开任何一道题，「正确答案」永远是「稍后就好」 | **根因已确认（03:10）**：学生进程一启动就跑后台解答队列，在发出「就绪」之前向网关申请图片名额；网关的名额监听器挂在握手之后，这条申请被静默丢掉，队列永久等待（`src/studentHost/workers.ts` 握手段）。本地按生产参数复现并验证修法：网关从 fork 起就接名额申请。CI 没抓到是因为测试里进程启动时库是空的 | 修复 PR 准备中（含回归测试）→ 合并即发布 → 线上开一道题核对几分钟内变成「AI 解答」 |
| A2 | ~~手机告警与日报没装~~ **已完成（03:14）**：运维脚本与单元已安装，`ops.env` 先跳过备份，Bark key 写入 `alert.env`（0600），干跑通过，真发一次日报用户手机已收到；巡检（每 5 分钟）和日报（22:30）定时器已启用，备份定时器未启用 | `systemctl list-timers 'sel-*'` 显示两个定时器 | 完成 |
| A3 | **没有每日备份、异地备份和恢复演练。** 只有发布时的同机备份（53 份，12 GB，含 env 与证书私钥） | `/var/backups/super-error-log-daily` 不存在；`ossutil`、`rsync` 都没装 | 用户选 OSS 或另一台主机并给凭证；之后按 RUNBOOK 第 7、9、10、11 步做，再做第 12 步清理 |
| A4 | ~~`sel-admin` 包装命令没建~~ **已完成（03:09）** | `/usr/local/sbin/sel-admin --help` 能列出用法 | 完成 |
| A5 | **公开说明页 `/help/` 的联系方式是「待补充」**，而且还在讲打印练习纸的一周循环 | PR #82 把页面改成「开始使用」为主、去掉打印步骤，但邮箱与微信二维码仍是占位 | 用户给邮箱和微信二维码；合并 #82 后再补一个小 PR |

## 二、上线前应做（不阻塞，但第一个学生会碰到）

| # | 事项 | 现状 | 谁 |
|---|---|---|---|
| B1 | 合并 PR #83：题干里的表格显示成一串竖线（真机可见） | 开着 | 用户合并（合并即发布，停服约 15 秒） |
| B2 | 合并 PR #91：找题不再因一题标记整页失败，绿勾不再被当成订正 | 开着，未审 | 建议先审再合 |
| B3 | 可观测性分支 `codex/observability-request-trace`（请求 ID、错误编号、浏览器出错上报、巡检按请求层告警）：学生说「出问题了」时能按编号查 | 本地 5 个提交，未推送、未开 PR | 开 PR → 审 → 合并 |
| B4 | 合并 PR #92（本文与新版学生指南） | 开着 | 用户合并 |
| B5 | 安卓 + 微信真机走一遍：登录、拍照、相册、详情页、语音 | 2026-11-01 只走了 iPhone 主屏幕版 | 用户（或借一台安卓机给 Claude 镜像） |
| B6 | 第一个学生的账号：建好 `sel-admin` 后 `sel-admin create` 预发邀请码；或让学生自助注册（当前不要注册码，全站上限 100） | 注册表有 7 个空间（2 个有题，都是测试用） | 用户决定方式 |
| B7 | 家长知情同意按 `docs/product/PILOT_PROTOCOL.md` 线下做；发布检查单里「隐私规则页与同意勾选已上线」一项已过时（#65 去掉了隐私规则页），下次改检查单时删掉 | — | 用户 |
| B8 | ~~journald 上限~~ **已完成（03:09）**：`SystemMaxUse=500M`，journald 重启后服务正常 | — | 完成 |
| B9 | 服务器上的发布程序 `/usr/local/sbin/sel-ci-deploy` 比仓库旧；RUNBOOK 第 13 步要求先做完第 9、10 步 | 未重装 | 备份与演练做完后再做 |

## 三、真机发现、可以上线后再修

- 搜索图标点了之后输入框不自动聚焦，要再点一下才能打字。
- 列表视图里多选的圆圈点不中（网格视图正常）；多选模式右上角的 ✓ 看不出作用。
- 原图查看器双击不放大，也没有旋转按钮（横拍的卷子要歪着看）。
- 章节筛选里混入「第2课时 公式法解方程」「B 中档题运用」「综合题探究」这类试卷小节名。
- 同一道题收录了两次（「函数 5. 已知实数 a>1…」），初中账号里有高中题（测试数据）。
- 语音被拒后的提示写「在浏览器设置里允许」，主屏幕版没有浏览器设置入口。
- 详情页每 4 秒轮询一次解答状态，解答一直不生成时会一直轮询。

## 四、Claude 在服务器上做过的（2026-11-01 03:09–03:14，用户同意后）

全部来自 `deploy/ops/RUNBOOK.md`，不碰学生数据，不停服。下面的命令已执行，留作记录。

```sh
# A4 / RUNBOOK 第 1 步：固定的管理命令包装
printf '%s\n' '#!/bin/sh' 'exec runuser -u supererrorlog -- env SEL_STUDENT_HOST_DIR=/var/lib/super-error-log/student-host /opt/super-error-log/node-v24/bin/node /opt/super-error-log/current/dist/studentHost/admin-cli.js "$@"' > /usr/local/sbin/sel-admin && chmod 0750 /usr/local/sbin/sel-admin
```

```sh
# B8 / RUNBOOK 第 4 步：日志上限
sed -i 's/^#\?SystemMaxUse=.*/SystemMaxUse=500M/' /etc/systemd/journald.conf && grep -q '^SystemMaxUse=' /etc/systemd/journald.conf || echo 'SystemMaxUse=500M' >> /etc/systemd/journald.conf; systemctl restart systemd-journald
```

```sh
# A2 / RUNBOOK 一之二 第 1 步：装运维脚本与定时器（不启用）
bash /opt/super-error-log/current/deploy/ops/install.sh
```

```sh
# A2 / 一之二 第 2–3 步：先不装备份；写 Bark key（key 来自 Bark App「服务」页推送链接 https://api.day.app/<key>/ 里的那段）
echo 'SEL_OPS_SKIP=backup' >> /etc/super-error-log/ops.env
printf 'SEL_ALERT_BARK_KEY=%s\n' '<key>' > /etc/super-error-log/alert.env && chmod 0600 /etc/super-error-log/alert.env
```

```sh
# A2 / 一之二 第 4–5 步：演练一次巡检，真发一次日报，再只启用巡检和日报
set -a; . /etc/super-error-log/ops.env; . /etc/super-error-log/alert.env; set +a; /opt/super-error-log/node-v24/bin/node /usr/local/lib/sel-ops/sel-healthcheck.mjs check --dry-run
systemctl start sel-daily-report.service
systemctl enable --now sel-healthcheck.timer sel-daily-report.timer && systemctl list-timers 'sel-*'
```

备份（A3）要等你选定异地目标并给凭证后，按 RUNBOOK 第 7、9、10、11 步做；做完恢复演练再做第 12 步清理旧发布备份（会删 50 份、释放约 11 GB）和第 13 步重装发布程序。

## 五、需要你给的

1. ~~Bark key~~ 已给，告警已通。
2. 异地备份选哪种：阿里云 OSS（同地域私有桶 + 只写该前缀的 RAM 子账号 AK）还是另一台主机（rsync）。
3. `/help/` 页面的邮箱和微信二维码图片。
4. ~~对第四节命令的一句「同意」~~ 已同意并执行。
5. 第一个学生用预发邀请码还是自助注册。
