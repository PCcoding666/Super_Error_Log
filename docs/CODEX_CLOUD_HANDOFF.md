# Codex Cloud 接手说明

更新时间：2026-10-21（Asia/Singapore / UTC+8）。这是当前开发入口；较早的 `.ai/tasks/current/`、MVP手册和原生iOS验收报告按各自日期理解。

## 0. 当前本地材料关联分支（未部署）

当前开发分支为 **`codex/material-linking`**，在原邀请网页分支上实现自由拍摄学习材料、跨页/跨日关联、独立作答与答案版本、显式 AI 答案/批改、错题收录以及新旧题混合练习/打印/延迟回传。`/s/capture` 使用新材料流程；iOS 没有本轮改造。以下生产版本说明仍指线上 0.5.0-r2，**本轮没有发布**。

- 不必先选材料类型、标签或分组，照片持久化确认后可离开；无标签同页可直接整理。整页不明确时一次选择候选，具体题目和作答可后续纠正。
- 缺题干答题卡可先录手工答案；第一次补齐题干时保留原题/作答身份与原答案历史，新 revision 绑定完整依据，已有明确采用意图保留。双方独立结果历史不能随便合并；后续题干替换/撤销会使受影响答案与批改过期。
- 拍照、改标签、录答案或刷新不会自动开始付费批改；老师痕迹、学生作答、订正、提供的答案和 AI 建议分开保存。掌握状态仍只由延迟回传规则更新，反思仍由学生提交。
- 网页共享学习入口可选择新材料题和历史题并完整打印；旧 API 不返回残缺的新/混合包。打印使用真实来源与选定答案版本，旧 ready 快照不改写。
- 合成邀请网关验收见 `tests/e2e/materialJourney.spec.ts`、`tests/integration/materialIsolation.test.ts`；原 `materialCapture.spec.ts` 的恢复/ACK/身份用例保持。最终本地 `SEL_AI_MODE=mock npm run verify` 已通过（Vitest 988 通过/5 跳过，Playwright 48 通过/1 跳过，typecheck/build 通过）；截图/点击数据见 `docs/quality/2026-10-20-material-linking.md`。Task10 与整分支最终独立审查尚未完成。

保守兼容边界：历史上传的 immutable fingerprint 若为 NULL，重放返回 409，服务器原材料仍保留，界面提供查看/删除本机草稿；不同账号切换清除旧本机草稿，同账号过期重新登录可恢复。未知学科不猜，跨片段转写仍按单个真实片段提交；真实模型准确率、真机体验和物理打印未由合成测试证明。所有执行裁定原文已保存在质量文档，不能把历史手册当当前能力或上线证据。

## 1. 从哪个版本继续

- 仓库：`PCcoding666/Super_Error_Log`（私有）。
- 原邀请版接手分支：**`codex/student-invite-web`**（本轮当前分支见第 0 节）。用户已明确授权把当前状态同步到GitHub，后续由Codex Cloud继续开发。
- 现有集成分支：`codex/ai-error-review-mvp`；本轮基于`5436a44`。GitHub默认`main`仍是早期版本，不是当前产品。
- 生产版本：**0.5.0-r2**，2026-10-15 13:48 UTC+8发布；运行代码提交`a006f0a`，随后`602323a`补充发布记录。接手说明的后续提交不代表额外上线。
- 学生入口：https://study.pccoding666.com/s/ 。生产资料/凭证不在仓库；不要为开发去创建或清空真实学生数据。
- 本轮只同步分支并建立PR，不自动合并或修改GitHub默认分支，也不因同步再次部署。

## 2. 生产 0.5.0-r2 实际做到哪里

学生从手机Safari/Android浏览器打开网页，用个人邀请码进入独立空间。可以添加主屏幕，不依赖Apple开发者账号安装原生App。

当前闭环：

1. 拍照或相册上传。浏览器转JPEG、按显示方向绘制、最长边4096，服务器保留独立体积/像素校验。
2. AI先定位整页题目。有红叉/订正的题自动精读；没有明确批改痕迹的候选题，由学生勾选后精读。不是自动重新批改整卷。
3. 题干、图形、可见作答/订正和原图进入错题本。不强制逐题校对，发现错误再修正；不是错题可移除。
4. 挑本周练习：规则优先推荐未独立做对、到期确认、当天做对和反复出现的知识点，最多8题；题少时可以1题。
5. AI结合原作答问一两句，学生语音/文字回答，确认错因并选自己的把握程度；允许跳过直接打印。
6. 生成可打印练习纸，提示和答案放末页；当前仍是原错题重做。低置信题可用遮白裁图，不能承诺遮盖/识别完全准确。
7. 隔几天纸上独立重做，学生对照答案录入做题日期、是否用了提示、是否正确。系统更新掌握状态并影响下次推荐。

注意：当天做对不算掌握。当前实现以练习包生成日到实际做题日的天数判断，`MIN_DELAY_DAYS=3`；不是自动验证学生确实独立完成，也不是语义上证明知识点已掌握。新题生成、变式题、答题卡自动配对、家长独立看板均未接入当前流程。

## 3. 最近完成与证据

| 项目 | 当前证据 | 尚未证明 |
| --- | --- | --- |
| 每学生独立空间 | 独立目录/SQLite/worker，双学生隔离、重启会话、撤销、路径攻击等测试；线上合成账号交叉资源404 | 大规模多人使用；目前上限3个空间 |
| 邀请码 | 12位随机码、7天有效、单次兑换，浏览器会话30天；管理员可给同一学生补码 | 自助找回、开放注册 |
| 语音 | `qwen-audio-3.1-asr-flash`，百炼原生接口；合成M4A/WebM真实转写通过 | 用户手机真人录音的端到端验收 |
| 照片上传热修复 | HEIC/48MP转换、超时、损坏图、重选、网络重试等专项；线上HEIC合成题上传后识别完成 | 各安卓机型/旧Safari兼容性、真实题目大样本准确率 |
| 用户手机上传 | **用户于2026-10-15明确说“我现在上传成功了”**，截图显示“已拍1张 · AI正在找题” | 此截图不代表这张真实卷子所有题目识别正确或整周使用已完成 |
| 主屏幕/纸张 | 网页已可用 | 添加主屏幕、真人录音、实际打印、真实学生一周闭环仍待确认 |

最近完整验收（2026-10-15，热修复代码）：`npm run verify`，typecheck/build通过，Vitest **745通过/2既有跳过**，Playwright **23通过**。这是macOS本地等内容副本的结果，不等于GitHub/Linux CI结果。Linux会按代码条件跳过依赖macOS HEIC/sips或未配置Caddy的用例。

线上热修复验收：独立合成账号、真实HTTPS、WebKit上传HEIC，返回200并登记；真实模型完成识别，1题ready且进入错题本。没有把用户原图作为线上测试再发给AI。

详细证据：
- [邀请码版发布](quality/2026-10-15-student-web-release.md)
- [照片热修复与真机反馈](quality/2026-10-15-photo-upload-hotfix.md)
- [语音验收](quality/2026-10-15-web-voice-acceptance.md)

## 4. 代码地图

| 位置 | 职责 |
| --- | --- |
| `src/main.ts` | 生产入口，`dist/main.js`；真实配置缺失拒绝启动 |
| `src/studentHost/` | 邀请码注册表、会话、同源网关、每学生独立子进程、管理员CLI |
| `src/mobile/` | 图片识别、先找题后精读、队列/容量/重试、旧原生App API |
| `src/bridge/recognitionToItems.ts` | 已选/自动识别的题桥接为学习记录，避免重复 |
| `src/v2/` | 周数据、练习选择、追问、修正、打印快照、回传和总结 |
| `src/web/router.ts` / `views/` | 当前手机网页路由与SSR页面，无React hydration |
| `src/web/assets.ts` / `photoUpload.ts` | 少量浏览器脚本、PWA缓存、图片准备/上传；资源版本目前3 |
| `src/web/weekPlan.ts` | 今天页和本周各步骤的下一步指引 |
| `src/ai/asr.ts` | Qwen ASR；密钥留在服务端，转写结果可编辑再提交 |
| `src/domain/stateMachine.ts` | 延迟重做/掌握规则 |
| `src/server.ts` / `src/app.ts` | 旧本地Web演示入口；`npm start`仍指向它，不是生产入口 |
| `iOS/` | 保留的原生客户端，本轮主交付不要求修改它 |

学生空间通过独立进程隔离现有全局db/config/provider；不要改成共享进程后仅在少数查询加studentId过滤。`SEL_STUDENT_HOST_ENABLED=1`才启用网关；其他开关见`.env.example`和`deploy/README.md`。

## 5. Cloud环境启动与验证

用Node **24**。初次环境安装需联网获取npm依赖和Playwright浏览器；真实AI密钥不是合成测试的前提。不要复制生产`.env`进入Cloud工作区。

```sh
node --version
NPM_CONFIG_REPLACE_REGISTRY_HOST=always npm ci
npx playwright install --with-deps chromium
SEL_AI_MODE=mock npm run verify
```

先装Chromium再跑Vitest：测试初始化用浏览器生成合成试卷。`NPM_CONFIG_REPLACE_REGISTRY_HOST=always`是仓库CI已有配置，用于将锁文件的镜像地址替换为官方npm源，保留完整性校验。

手机网页外观/流程预览：

```sh
npm run web:fake
```

默认3198，控制端口3199，只监听本机；终端给出的链接是**旧单学生配对夹具**，没有新邀请码隔离。别把它当生产入口，也别和完整E2E同时运行（端口会冲突）。

邀请码/上传的真实网关合成测试：

```sh
npx vitest run tests/integration/studentHost.test.ts tests/integration/studentHostReview.test.ts --no-file-parallelism
npx playwright test tests/e2e/studentHost.spec.ts tests/e2e/photoUpload.spec.ts
```

`tests/e2e/studentHostServer.ts`由测试fork启动，以IPC传本机地址和测试邀请码；不要直接运行它等终端打印网址。浏览器测试自动清理临时学生目录。`tests/fixtures/photo-upload.heic`是1994字节的纯色合成图片，不是用户照片。

CI：`.github/workflows/ci.yml`在每个PR以及集成分支/main推送时验证，**不会部署**。详见[CI说明](ci.md)。Cloud的实现报告要区分本地测试、Actions检查、线上运行和用户验收。

已知开发限制：旧本地PDF下载使用Express默认dotfiles策略，工作树位于隐藏路径（例如`.codex`）时可能404；上次在非隐藏目录的等内容副本验收通过。不要因此改宽整个生产静态文件访问权限。

## 6. 接下来怎么做

本次没有批准新一轮功能扩张；接下来的开发范围以用户在Cloud下达的任务为准。建议先补真实使用反馈：

- 看本次真实试卷有没有漏题/错题干、补勾和修正是否顺手。
- 实际走一次选题、语音追问、打印、隔天录结果，记录卡点。
- 分别确认主屏幕安装、真人录音、纸张打印，不能把浏览器截图算作全部完成。
- 后续候选：答题卡与卷子关联、针对知识点的变式题/新题、主动复习建议、家长汇总、Liquid Glass视觉调整；都不在本次已交付范围。

交付新修改时：给出改动、运行过的检查、未验证项和PR。生产部署、清理真实学习记录、撤销邀请码/会话等操作按用户当次授权执行。不要重置学生数据来让测试通过。

## 7. 上下文与保密边界

当前产品依据按时间顺序：
1. [学生闭环v2设计](superpowers/specs/2026-09-29-student-loop-v2-design.md)
2. [先找题→学生勾→再精读](superpowers/plans/2026-10-02-select-then-read-v2-1a.md)
3. [学生邀请码网页设计](superpowers/specs/2026-10-15-student-invite-web-design.md)
4. 本交接说明、最近发布记录及用户后续指示。

用户偏好：用中文、说人话，少用工程术语。手机是主交互；系统记录在服务器；减少学生逐题校对负担；先把学习流程跑顺，再做视觉重设计。

`.superpowers/`里WorkBuddy日志/私有验收脚本、服务器凭证、邀请码、会话、真实照片/语音均不上传GitHub，也不是Cloud开发的必需依赖。它们的有效结论已整理进上述文档。旧`.ai/tasks/current/`保留原样，不代表当前上线状态。
