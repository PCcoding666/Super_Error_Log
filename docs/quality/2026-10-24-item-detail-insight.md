# 详情页五块 + 后台 AI 解答（2026-10-24）

用户在真机截图上提的要求，分两轮：

1. 「你写的」不要重复两行；「老师批注」改叫「批改痕迹」；章节和知识点合成一块；加「正确答案」（AI 解题过程，用 Markdown 显示）和「推测错因（备注）」，学生可以自己记。
2. 解答改成后台异步任务，非忙时做、不要在上传切题的时候做，不用强调生成中、强调重试；用 qwen3.8-max；必须看图；立体几何、图像类可以给交互内容；识别出的内容都要能改；可以拍照录入答案；备注要能语音输入；深色模式卡片看不清的问题一起修。

界面与接口见 [学生端单页应用](../CLIENT_APP.md)，这里记录取舍、证据和人工发布。

## 做了什么

| 部分 | 实现 |
| --- | --- |
| 五块 | 你写的（原作合在一处，订正 / 看不出是谁写的单独标出）、批改痕迹、章节与知识点（一张卡）、正确答案、错因（备注） |
| 后台解答 | `src/v2/insightService.ts`：每个学生进程一个队列；这个学生在识别 / 整理材料 / 准备打印时不做；一次一道；打开详情页只排到最前。向父进程借模型名额时排在所有学生的前台请求之后，名额满了前台还在等就让出（`permits.ts` 的 preempt，中止那次调用、稍后重排、不算失败） |
| 缓存与重试 | 按题目内容指纹（识别文字、revision、拍的答案）缓存；失败自动再试一次，之后等学生点「重试」；每题每小时最多 6 次讲解调用 |
| 范围与费用 | 只自动处理最近 `SEL_INSIGHT_BACKFILL_DAYS`（缺省 30）天录入的题；更早的题打开详情页时才排队。0 表示只做学生打开过的题 |
| 看图 | 旧流程题发整题图（题目 + 作答 + 批改区域），材料题发裁图，最多 6 张、长边 1600 |
| 交互图 | 立体几何：模型只给点坐标、棱、要强调的线和面，我们自己的脚本画成能拖动旋转的 3D 线框图；其他（函数图像、物理等）是模型写的自包含 HTML。都在单独的沙箱页里（自己的 CSP：不许网络、表单、外部资源，强制不透明来源，只许本站嵌入），iframe 再加 `sandbox="allow-scripts"` |
| 推测错因 | 只依据学生原作；没有原作服务器强制不给（不靠模型自觉）；AI 推测不写进备注，不算反思 |
| 改识别结果 | 题干、你写的、批改痕迹、照片里的参考答案都能改；走已有的键盘直改（`directCorrection`），学生原作只能改回纸上写的（改动 ≤ 原文一半且 ≤ 20 字），改完解答重新排队 |
| 拍照录入答案 | 每题最多 3 张，缩到长边 2048 存库；后台找出这道题的答案转写（`answer_read`），转写可改、没找到可以自己填、可重新识别、可删；转写作为解答的参考 |
| 语音备注 | 浏览器录音 → 已有的 `POST /s/voice`（同一个转写服务和限流），文字接在备注后面并保存 |
| 深色模式 | `theme.css` 的深色值写到 `:root.ios`，盖过 Ionic iOS 深色调色板的纯黑卡片，全应用生效 |

模型：`explain`、`answer_read` 两个新阶段，百炼模式缺省都用 `qwen3.8-max`（用户指定，不跟 `SEL_AI_MODEL`），可用 `SEL_AI_MODEL_EXPLAIN` / `SEL_AI_MODEL_ANSWER_READ` 改。解答输出上限 16384 token、超时 240 秒（后台任务）。

数据：只新增三张表 `item_insight`、`item_answer_photo`、`item_note`（外键随题目删除），不改旧表。旧版本代码不认识这三张表，回退代码不需要恢复数据库。

## 证据

本地（Linux 云端开发容器，mock AI）：

- `npm run typecheck`、`npm run build` 通过。
- Vitest：新增 `tests/integration/itemInsight.test.ts`（后台队列：空闲才做、忙时不做、范围外不自动做、改内容重做、无原作不推测、自动重试与手动重试、每小时上限、被前台抢走名额不算失败、整题图缩放后发给模型、拍的答案转写后作为参考、改 / 删答案后重新生成、备注、级联删除）、`tests/unit/itemInsight.test.ts`（契约、LaTeX 反斜杠修复、交互图结构校验、沙箱页 CSP）、`tests/unit/permits.test.ts`（后台排在前台之后、不占最后一个名额、被抢占只请一次）、`tests/integration/stagedProvider.test.ts`（真实 HTTP 边界：explain / answer_read 用对应阶段模型、带图、带拍的答案）。
- Playwright：`app.spec.ts` 覆盖五块、Markdown 与公式、交互图脚本在沙箱页里运行、立体图能拖动旋转、改题干、改原作超幅被拒、拍照录入答案、语音备注；`appMaterials.spec.ts` 经过邀请码网关，确认交互图页面的 CSP 不被网关覆盖、材料裁图发给了模型。
- 本容器以 root 运行，`tests/unit/pairing.test.ts`、`tests/unit/mobileStore.test.ts` 各有一个「写文件失败」用例在改动前后都失败（root 写得进去），与本改动无关。

真实模型（百炼 `qwen3.8-max`，合成题，不是学生材料）：

| 调用 | 结果 |
| --- | --- |
| 看图可行性 | 合成图片「2x + 3 = 11 + 一个圆」，按应用同样的请求格式（json_object、不开思考）2.7 秒答对方程、解和形状 |
| 解答（立体几何：正方体棱长 2，求 A₁C 与底面所成角的正切；学生写 √2、老师打叉） | 18.8–29.3 秒；输入约 1.4–1.7k、输出约 1.1–1.8k token；答案 √2/2 正确；错因指出把比值算反；第三版提示词下按要求给出立体图数据（8 个顶点、12 条棱、3 条强调线、底面），渲染后能拖动旋转 |
| 拍的答案页 | 2–2.7 秒；找到第 7 题那一行并原样转写，没有自己补全（合成图片把这一行截断了，转写也停在截断处） |

前两版提示词暴露的问题已改：答案只写 LaTeX 不包 `$`（现在服务器自动包上）；模型自己写的「3D 图」是静态图、文字用 `$…$`、颜色写死成深灰在深色模式看不清（现在立体图改由程序画，HTML 图固定白底，提示词要求不用 LaTeX）。

尚未证明：真实学生照片上的解答和错因准确率、函数图像类 HTML 交互图的稳定性、生产机（2 核 / 1.8 GB、`SEL_GLOBAL_AI_CONCURRENCY=1`）上后台任务和前台识别交替时的实际体验、费用。

## 费用提醒

每道题一次解答约 3k token（qwen3.8-max，带一张图）。上线后每个学生的进程会在空闲时把最近 30 天录入的题慢慢补齐；题多的话先把 `SEL_INSIGHT_BACKFILL_DAYS` 调小（比如 7，或 0 只做打开过的题），看一两天账单再放开。

## 人工发布

合并到 `main` 后 CI 会照常构建，但发布程序发现 `dist/db/` 变了会拒绝（`Database migration code changed; manual release required`），服务器保持旧版本。用下面的提示词让服务器上的 agent 做人工发布。

<a id="server-prompt"></a>

```text
你在生产服务器上以 root 身份做一次「人工发布」。项目是 super-error-log（学生错题本），仓库 PCcoding666/Super_Error_Log。
这次发布 = 已合并到 main、CI 全绿、但自动发布因为数据库迁移被拒绝的那次运行。只做下面列出的事；任何一步和预期不符就停下来把情况报告给我，不要自己想办法绕过。

绝对不要：删除或清空任何学生数据（/var/lib/super-error-log 下的任何文件）、改密钥或邀请码、把学生照片 / 题目 / 数据库内容或 env 文件内容打印到对话里、改 Caddy、改 systemd 单元文件、重装 /usr/local/sbin/sel-ci-deploy。

背景
- 安装目录 /opt/super-error-log，releases/ 下每个版本一个目录，current 是指向当前版本的软链；Node 在 /opt/super-error-log/node-v24/bin。
- 数据目录 /var/lib/super-error-log，服务 super-error-log.service，运行用户 supererrorlog，环境文件 /etc/super-error-log/env（root 0600）。
- 自动发布程序把已校验的发布包留在 /var/lib/sel-ci/<RUN>/release.tar.gz（<RUN> 形如 1234567890-1），状态在同目录 status.json，失败原因在 failure.log。
- 这次只新增了三张表（item_insight、item_answer_photo、item_note），启动时自动建；不改旧表。旧版本不认识这三张表，回退代码不需要恢复数据库。

步骤
1. 找到这次运行：ls -t /var/lib/sel-ci/ | head；对最新的几个看 cat /var/lib/sel-ci/<RUN>/failure.log 和 status.json。要找的是 failure.log 写着 "Database migration code changed; manual release required"、status.json 里 commit 等于我给你的合并提交 <COMMIT> 的那一次。找不到就停下来问我。
2. 记下当前版本：readlink -f /opt/super-error-log/current（下面叫 PREVIOUS）。确认 systemctl is-active super-error-log 是 active，df -h /opt 至少 2 GiB 空闲。
3. 解包到新目录（不要用 ci- 开头的名字，也不要覆盖已有目录）：
   R=/opt/super-error-log/releases/manual-<RUN>
   test ! -e "$R" || { echo "已存在，停"; exit 1; }
   T=$(mktemp -d) && tar -xzf /var/lib/sel-ci/<RUN>/release.tar.gz -C "$T" && mv "$T/super-error-log" "$R" && rmdir "$T"
   核对：cat "$R/deploy/ci-release.json" 里的 commit 等于 <COMMIT>；ls "$R" 只有 dist、deploy、package.json、package-lock.json、.env.example。
4. 装生产依赖，和自动发布完全一样（独立账号、不跑安装脚本、官方源）：
   chown -R sel-build:sel-build "$R"
   cd "$R" && runuser -u sel-build -- env HOME=/var/cache/sel-build NPM_CONFIG_CACHE=/var/cache/sel-build/npm LANG=C.UTF-8 /opt/super-error-log/node-v24/bin/npm ci --omit=dev --ignore-scripts --registry=https://registry.npmjs.org --no-audit --no-fund
   chown -hR root:root "$R" && chmod -R go+rX,go-w "$R"
5. 环境文件：先备份 cp -p /etc/super-error-log/env /root/backup-sel-env-$(date +%Y%m%d-%H%M)。确认里面 SEL_AI_MODE=bailian。在文件末尾追加（已有同名行就不要重复加，报告给我）：
   SEL_AI_MODEL_EXPLAIN=qwen3.8-max
   SEL_AI_MODEL_ANSWER_READ=qwen3.8-max
   SEL_INSIGHT_BACKFILL_DAYS=30
   然后用 env 里的百炼密钥确认这个账号能用 qwen3.8-max（只发一句纯文字，不要发任何学生内容，不要把密钥打印出来）：
   set -a; . /etc/super-error-log/env; set +a
   curl -sS -o /dev/null -w '%{http_code}\n' https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions -H "Authorization: Bearer ${SEL_AI_API_KEY:-$DASHSCOPE_API_KEY}" -H 'content-type: application/json' -d '{"model":"qwen3.8-max","messages":[{"role":"user","content":"回复 ok"}],"max_tokens":5,"enable_thinking":false}'
   如果 env 里有 SEL_TOKEN_PLAN_API_KEY（应用会先走 Token Plan 接口），再用它测一次同样的请求，地址换成 https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions、密钥换成 ${SEL_TOKEN_PLAN_API_KEY}。
   按量接口不是 200 就停下来告诉我（不要换模型）；Token Plan 不是 200 也告诉我（应用会退到按量接口，但受每日备用上限限制），这一项不挡发布。
6. 等空闲：runuser -u supererrorlog -- /usr/local/sbin/sel-ci-deploy --busy 输出 0 才继续；不是 0 就每 10 秒看一次，最多 5 分钟，还不是 0 就停下来告诉我。
7. 发布前备份（只放在本机 /root，root 可读）：tar -czf /root/backup-sel-$(date +%Y%m%d-%H%M).tar.gz -C /var/lib/super-error-log .
8. 切换：systemctl stop super-error-log
   ln -sfn "$R" /opt/super-error-log/current.manual-next && mv -T /opt/super-error-log/current.manual-next /opt/super-error-log/current
   systemctl start super-error-log
9. 检查（30 秒内）：
   systemctl is-active super-error-log 是 active；
   curl -sS -o /dev/null -w '%{http_code}\n' https://study.pccoding666.com/s/ 是 200（登录页）；
   journalctl -u super-error-log --since "-3 min" --no-pager | tail -50 里没有「缺少 SEL_AI_MODEL_」「Error」之类的启动错误（只看、只报告错误类型，不要把含学生内容的行贴出来）。
   任何一项不对：立刻回退（第 10 步），再告诉我。
10. 回退（只在第 9 步失败时）：ln -sfn "PREVIOUS" /opt/super-error-log/current.manual-next && mv -T /opt/super-error-log/current.manual-next /opt/super-error-log/current && systemctl restart super-error-log；不要恢复数据库备份；env 里加的三行留着无害。
11. 报告：PREVIOUS、新的 current、ci-release.json 里的 commit、第 9 步三项结果、第 5 步 curl 的状态码。

完成后我会在手机上打开一道题看：几分钟内（没有上传的时候）「正确答案」变成「AI 解答，仅供参考」，错因里有 AI 推测；拍照录入答案、改识别结果、语音备注都能用。
```
