# 发布检查单（2026-10-22 更新）

`main` 是唯一开发与生产分支。**合并到 `main` 并且 CI 通过 = 自动上线**（`.github/workflows/ci.yml` → `deploy.yml` → 服务器上的固定发布程序 `/usr/local/sbin/sel-ci-deploy`，见 `deploy/ci/README.md`）。所以“合并”就是“发布”，下面每一项都在合并前完成。运维（备份、告警、恢复演练）见 `deploy/ops/RUNBOOK.md`。

## 每个 PR 合并前

- [ ] `npm run verify` 全绿：typecheck + Vitest（单元/集成）+ build + Playwright E2E。以当次输出的数量为准，不再写死测试个数。
- [ ] 改了 `deploy/ci/` 或发布相关：`python3 -m unittest discover -s tests/deploy -p 'test_*.py'` 通过（CI 也会跑）。
- [ ] PR 描述写清：改动、跑过的检查、未验证项（真机、生产才有的东西）、风险与回滚方式、对应总表编号。
- [ ] 无新增密钥或真实学生数据：`git status` 无 `.env`、密钥、`data/`、`data-e2e/`、真实照片/录音、邀请码、会话令牌；测试与截图只用合成数据（如「测试学生甲」、13800000000 式假号码）。
- [ ] 领域规则没有被削弱：AI 只提取和建议；当天做对不算掌握（只有隔 3–7 天的独立重做算）；家长只看汇总。真实 AI 模式缺配置必须直接失败，不得静默退回 Mock。
- [ ] 数据库：只允许新增表/列（带缺省值），已有数据继续可用。改到 `src/db/` 或 `src/studentHost/registry.ts` 时自动发布会拒绝，必须安排人工发布（`deploy/ci/README.md`「失败与恢复」）。

## 什么时候合并

- [ ] 一次合并一个 PR，等上一次的 `production` 任务完成、`/s/` 正常后再合下一个。
- [ ] 发布前看一眼服务器空闲盘（`df -h /`）：低于 2 GiB 发布会被拒绝，低于 3 GiB 学生上传会被拒收。

## 合并后

- [ ] Actions 里 `production / release` 成功；摘要里的提交与刚合并的一致。失败时看失败任务；启动检查失败会自动切回旧版本（Actions 仍显示失败）。
- [ ] 手机打开 `https://study.pccoding666.com/s/` 能看到登录页；`/admin/` 能登录，「按调用线路」有数据。`https://study.pccoding666.com/` 仍是 404。
- [ ] `https://study.pccoding666.com/help/` 打开产品说明页（200 HTML）；`/help` 跳到 `/help/`。`help.pccoding666.com` 子域名暂不使用，发布不依赖它，也不要为它改 DNS 或 Caddy。
- [ ] 如果 PR 改了 `deploy/ci/sel-ci-deploy.py` 或 `deploy/ops/`：服务器不会自动用上新版本，按 RUNBOOK 第 13 / 6 步由管理员重新安装（第 13 步之前必须先做完第 9、10 步的第一次备份和恢复演练）。

## 给真实学生用之前（一次性）

- [ ] 完成 `deploy/ops/RUNBOOK.md`「Day 0」全部步骤，特别是：每日备份 + 异地 + **做过一次恢复演练**、5 分钟巡检推送到手机、后台口令、旧发布备份只留 3 份、阿里云快照与费用预警、按量付费每日上限。
- [ ] 学生登录用老师/管理员预发的邀请码。邀请码有效期和会话时长以 `src/studentHost/registry.ts` 的 `INVITATION_TTL_MS`、`SESSION_TTL_MS` 为准（2026-10-22 时：码 60 天内可重复登录，会话 30 天），不再是“7 天一次性码”。
- [ ] 真机各走一遍（一台 iPhone + 一台国产安卓，都在微信里打开）：注册/登录 → 拍卷 → 收录 → 练习 → 记结果。
- [ ] 隐私规则页与同意勾选已上线（`docs/privacy/`），联系人可用。
- [ ] 首批 ≤ 8 人、错峰使用；容量配置 `SEL_MAX_LIVE_WORKERS`、`SEL_GLOBAL_AI_CONCURRENCY` 与 `deploy/README.md` §7 的小机档一致。
- [ ] 证书续期窗口（11/16–11/18）那周每天看一次巡检推送或 `journalctl -u super-error-log-caddy`。
