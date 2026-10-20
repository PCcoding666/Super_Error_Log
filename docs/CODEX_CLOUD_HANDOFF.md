# Codex Cloud 接手说明

更新时间：2026-10-20（Asia/Singapore / UTC+8）。这是当前开发入口；较早的 `.ai/tasks/current/`、MVP手册和原生iOS验收报告按各自日期理解。

## 1. 从哪个版本继续

- 仓库：`PCcoding666/Super_Error_Log`（私有）。
- 唯一主分支：**`main`**。从最新 `origin/main` 新建 `codex/<任务>`，PR 目标也选 `main`。
- 2026-10-15 用户授权统一分支：此前发布分支 `codex/ai-error-review-mvp` 的完整历史（含 PR #11）归入 `main`，旧分支退役。不要继续从旧任务分支开发。
- 最近人工发布基线：**0.5.0-r2**，2026-10-15 13:48 UTC+8发布；运行代码提交`a006f0a`，随后`602323a`补充发布记录。自动发布启用后，当前版本以 [Actions 发布摘要](https://github.com/PCcoding666/Super_Error_Log/actions) 和服务器 `current/deploy/ci-release.json` 为准，不要把这条历史基线当成实时版本。
- 学生入口：https://study.pccoding666.com/s/ 。生产资料/凭证不在仓库；不要为开发去创建或清空真实学生数据。
- 发布授权（2026-10-15）：用户选择“合并后自动上线”，并授权主分支整理。只有 `main` push 的 CI 全绿才会调用 production；PR 和其他分支不发布。发布规则见 [自动发布说明](../deploy/ci/README.md)。
- R2 的 27 条提交在 PR #13 中逐项审查整合，取舍和验收见 [审查记录](quality/2026-10-15-pr13-review.md)；实际合并/发布状态查看 PR 和 Actions。历史界面设计已存入 docs，详见 [分支说明](BRANCHES.md)。

## 2. 产品实际做到哪里

学生从手机Safari/Android浏览器打开网页，用个人邀请码进入独立空间。可以添加主屏幕，不依赖Apple开发者账号安装原生App。

当前闭环：

1. 拍照或相册上传。浏览器转JPEG、按显示方向绘制、最长边4096，服务器保留独立体积/像素校验。
2. AI先定位整页题目。有红叉/订正的题自动精读；没有明确批改痕迹的候选题，由学生勾选后精读。不是自动重新批改整卷。
3. 题干、图形、可见作答/订正和原图进入错题本。不强制逐题校对，发现错误再修正；不是错题可移除。
4. 练习首页先恢复未完成任务；没有当前任务时主动建议最多3题，学生可直接接受或自行调整1–8题。支持暂缓、继续和取消剩余题；保留已记录结果。
5. 默认手机查看题目、白纸作答，也可打印。提示按需展开，答案仍在核对/可选打印页；学生反思可以另行补充。
6. 纸上标注本次题号后拍照，一张可含多题，一题可跨多张；本次最多保存12张，上传失败仅重试失败照片。作答单独存在本次练习中，不导入错题本。
7. AI结合冻结题面、参考答案和本次所有照片给出初步核对建议。缺题号可由学生关联，字迹不清/过程不全/参考缺失保留待处理；不把未收到的作答记成做错。
8. 学生一次确认实际日期和是否用过帮助，可改建议、对单题覆盖日期/帮助、部分记录并回来补拍，也可直接对照答案录结果。只有学生确认后才调用既有掌握规则。

照片、分析状态及版本持久化；重复上传/确认不重复记账，旧分析不能覆盖新照片。重启中断的分析显示重试入口，每个照片版本最多3次。实现与验证范围见[纸上练习验收](quality/2026-10-20-proactive-paper-practice.md)。

注意：当天做对不算掌握。当前实现以练习包生成日到实际做题日的天数判断，`MIN_DELAY_DAYS=3`；不是自动验证学生确实独立完成，也不是语义上证明知识点已掌握。新题生成、变式题、iPad白板、家长独立看板均未接入当前流程。

账号身份标签（2026-10-15）：注册表给每个账号存 student/parent/teacher/admin 标签，缺省及老账号迁移后均为 student。只是元数据——设置页只读展示，不参与任何鉴权，各账号空间/会话/数据完全不变。只能由管理员本机 `admin-cli set-role` 修改（create 也可指定），网页/浏览器没有改身份的入口；家长/老师/管理员的专属权限与账号关系未实现。

## 3. 最近完成与证据

| 项目 | 当前证据 | 尚未证明 |
| --- | --- | --- |
| 年级 / 学科 / 章节与跨章节选题（开发分支，待合并） | 年级默认初三、单题分类编辑、跨章节包含历史题、超过 8 题保留选择；详见[分类验收说明](quality/2026-10-16-grade-chapter-classification.md) | 真实手机和生产验收；合并前与学科切换 PR #20 检查集成 |
| 相册批量上传（开发分支，未合并） | 多选自动串行上传、逐张/整批进度；5 张中 1 张失败仍保留其余 4 张，重试只补传失败项；重复点击与成功响应丢失的幂等验收 | 真实手机多选与生产验收；详见[批量上传验收](quality/2026-10-15-album-batch-upload.md) |
| 每学生独立空间 | 独立目录/SQLite/worker，双学生隔离、重启会话、撤销、路径攻击等测试；线上合成账号交叉资源404 | 大规模多人使用；目前上限3个空间 |
| 邀请码 | 12位随机码、7天有效、单次兑换，浏览器会话30天；管理员可给同一学生补码 | 自助找回、开放注册 |
| 语音 | `qwen-audio-3.1-asr-flash`，百炼原生接口；合成M4A/WebM真实转写通过 | 用户手机真人录音的端到端验收 |
| 照片上传热修复 | HEIC/48MP转换、超时、损坏图、重选、网络重试等专项；线上HEIC合成题上传后识别完成 | 各安卓机型/旧Safari兼容性、真实题目大样本准确率 |
| 用户手机上传 | **用户于2026-10-15明确说“我现在上传成功了”**，截图显示“已拍1张 · AI正在找题” | 此截图不代表这张真实卷子所有题目识别正确或整周使用已完成 |
| 主屏幕/纸张 | 网页已可用 | 添加主屏幕、真人录音、实际打印、真实学生一周闭环仍待确认 |

历史热修复验收（2026-10-15；PR #13 的新一轮结果见审查记录）：`npm run verify`，typecheck/build通过，Vitest **745通过/2既有跳过**，Playwright **23通过**。这是macOS本地等内容副本的结果，不等于GitHub/Linux CI结果。Linux会按代码条件跳过依赖macOS HEIC/sips或未配置Caddy的用例。

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
| `src/web/assets.ts` / `clientScript.ts` / `photoUpload.ts` | 静态壳与浏览器渐进增强、图片转换/上传；CSS/JS 内容指纹自动更新缓存 |
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

CI：`.github/workflows/ci.yml`在每个PR以及 `main` 推送时验证；**仅 `main` push 全绿后自动发布**。详见[CI说明](ci.md)和[发布说明](../deploy/ci/README.md)。Cloud的实现报告要区分本地测试、Actions检查、线上运行和用户验收。

已知开发限制：旧本地PDF下载使用Express默认dotfiles策略，工作树位于隐藏路径（例如`.codex`）时可能404；上次在非隐藏目录的等内容副本验收通过。不要因此改宽整个生产静态文件访问权限。

## 6. 接下来怎么做

本次没有批准新一轮功能扩张；接下来的开发范围以用户在Cloud下达的任务为准。建议先补真实使用反馈：

- 看本次真实试卷有没有漏题/错题干、补勾和修正是否顺手。
- 实际走一次选题、语音追问、打印、隔天录结果，记录卡点。
- 分别确认主屏幕安装、真人录音、纸张打印，不能把浏览器截图算作全部完成。
- 后续候选：答题卡与卷子关联、针对知识点的变式题/新题、主动复习建议、家长汇总、Liquid Glass视觉调整；都不在本次已交付范围。

交付新修改时：给出改动、运行过的检查、未验证项和PR。合并后的常规自动发布已经授权；清理真实学习记录、撤销邀请码/会话、破坏性数据库迁移等仍需单独授权。不要重置学生数据来让测试通过。

## 7. 上下文与保密边界

当前产品依据按时间顺序：
1. [学生闭环v2设计](superpowers/specs/2026-09-29-student-loop-v2-design.md)
2. [先找题→学生勾→再精读](superpowers/plans/2026-10-02-select-then-read-v2-1a.md)
3. [学生邀请码网页设计](superpowers/specs/2026-10-15-student-invite-web-design.md)
4. 本交接说明、最近发布记录及用户后续指示。

用户偏好：用中文、说人话，少用工程术语。手机是主交互；系统记录在服务器；减少学生逐题校对负担；先把学习流程跑顺，再做视觉重设计。

`.superpowers/`里WorkBuddy日志/私有验收脚本、服务器凭证、邀请码、会话、真实照片/语音均不上传GitHub，也不是Cloud开发的必需依赖。它们的有效结论已整理进上述文档。旧`.ai/tasks/current/`保留原样，不代表当前上线状态。
