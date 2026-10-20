# 材料关联：本地合成验收记录

记录日期：2026-10-21（Asia/Singapore）；文件名沿用 2026-10-20 的方案日期。分支 `codex/material-linking`，Task10 起点 `39187732739cdfe40a88f47f942aab58ba9183df`。这是本地实现与合成验证，**没有部署**，不代表线上已有这些功能。Task10 独立审查已通过；整分支最终审查发现 3 项 Important，首轮修复后的 scoped review 又发现 2 项 Important（分拆固化派生学科、移动端原图身份缺失时退回 derivative）。两项已追加修复，下一轮 fresh scoped review 尚未进行，不预写批准。

## 本地能力与验证入口

真实邀请网关 `/s/`、独立学生 worker、真实 SQLite/文件持久化及真实业务服务贯穿三条浏览器旅程。仅识别内容、答案/批改 provider 和经过天数使用合成替身；未调用真实 AI，未使用真实学生资料。

- 答题卡先拍，先手工录正确答案，再拍乱序题干；一次整页确认合并。跨日答案照片带来一处冲突，明确选用手工答案；收录、安排练习、跳过反思、打印、按延迟日期回传，得到延迟独立做对状态。
- 无标签同页题干与作答；提取失败、答案失败、批改失败各显式重试。刷新不自动生成答案或批改。取消/恢复推荐保持同一学习题；独立补拍的第二次作答经真实“另记一次”关联保留在同一题。混合历史旧题与新材料题共同推荐、共同生成完整练习纸。
- 两个学生使用同题号、同标签、同文件；跨学生题目/原图拒绝，旧 namespace 写入拒绝，切号清除旧账号本机待传草稿，服务器已保存材料保留。回到原账号不把已清除草稿冒充保存。**同账号过期重登录恢复**仍由原有 `materialCapture.spec.ts` 用例覆盖，未弱化。

测试夹具为 `tests/e2e/studentHostServer.ts`、`tests/e2e/materialFixture.ts`、`tests/helpers/materialGateway.ts`。控制经 fork IPC 进行，无测试 HTTP 入口；worker 只有 `SEL_STUDENT_WORKER_FAKE=1`、`NODE_ENV=test`、`SEL_AI_MODE=mock` 三条件才允许载入动态测试模块。答案与批改注册真实业务处理器，延迟/失败仅包裹测试处理；历史旧题通过带内部令牌的真实 `/v1/recognitions` 与 `/v2/photos/:id/register` 创建，再由浏览器勾选，未直写假 Evidence 或绕过业务服务。

## 实际发现与修复

1. **先录手工答案后补题干被分裂。** `materialLinks.test.ts` 首个新增测试得到 2 题而非 1，日志 `/tmp/task10-manual-first-red.log`。仅允许唯一兼容的纯 question/diagram 侧作为补充来源，该侧不得有学习 item、答案历史、批改、作答或显式答案选择。原答题卡侧保留 question ID、attempt ID、全部历史。双方独立历史冲突保护保持。
2. **首次补齐的答案依赖。** 答题卡必须有实际 student_work，而且持久化关联历史从未拥有 question/diagram；不能把“曾有题干后删除”当首次补齐。仅当前有效、原依赖为空的手工答案参与。整个关联操作最终事件完成后，对原 answer ID 追加 revision，保留原文字与来源，以 `dependencies_json.firstCompletion` 记录旧 revision/basis，并绑定全部新题干。旧版本保留为过期；显式采用意图只对该同内容/同来源的首次补齐延续到新 revision。整页关联、明确 document 直接关联、题目上下文补拍都覆盖。后续已知题干替换仍使答案 stale；AI/grade 没有豁免。撤销恢复原材料身份及作答，完成版答案变 stale、两个答案版本仍可读，不把撤销后的依据装作有效。多片段/反向关联曾复现新版本立即 stale，修复为完整操作后绑定：`/tmp/task10-first-completion-red2.log`。直接补拍也先 RED：`/tmp/task10-direct-red.log`。
3. **缺题干入口太靠后。** 实际 390×844 截图中“补充材料”顶点为 1399.11px，“输入正确答案”也在首屏以下。现把补拍和手工答案入口置于摘要后，缺题干时收起完整批改面板。实测顶点分别 273.33px / 337.33px。原失败截图 `/tmp/task10-material/missing-stem-mobile-before.png`，修复后 `/tmp/task10-material/missing-stem-mobile.png`、`missing-layout.json`。
4. **长题号使列表原图摘要横向溢出。** 64 位合成题号在原图摘要使 390px 页面扩到 566px，截图实际查看后只给该处及候选摘要增加断行；题目、标签与来源内容保持。RED `/tmp/task10-journeys-run3.log`；GREEN `/tmp/task10-journeys-run4.log`。

5. **已采用答案仍要求再次选择。** 实际桌面来源截图显示显式采用成功后仍提示“请明确选择”。浏览器断言先 RED（`/tmp/task10-selected-copy-red.log`），页面现在复用服务端 `selectedAnswerIds` 有效性结果：有效选择时说明本次已采用；没有有效选择时才要求选择。原 `answerConflict` 与阻断规则不变。
6. **完整门禁发现旧数据改写。** 首轮 verify 的 typecheck/build 通过，但 8 个既有 `materialMigration` 测试失败：没有 mobile_item_link 的旧 item 被学习投影改写摘要/学科/标签/时间。增加 owner-scoped `material_legacy_map(source_kind=error_item)` 保护；未削弱迁移断言。迁移后显式 sync/关联仍不改旧行，同时新材料题转写能继续更新学习摘要。26 个 migration/learning 测试通过，`/tmp/task10-migration-green.log`。

7. **故障注入安装时机。** `materialJourney + materialCapture` 首次联合跑为 24 通过/2 失败：lost-ACK 用例未显示重试，429 用例实际拦截请求数为 0（不是“两次过快”）。诊断显示 `navigator.serviceWorker.controller=false`，但 `enter()` 返回时尚无 `[data-material-capture]`，同 URL 的 consent 重定向仍在提交。根因是测试在旧文档安装 page 拦截的导航竞态；不是生产队列错误。只给 enter 增加真实目标拍照文档可见的等待，无固定 sleep；两个原用例 `--repeat-each=3` 全部 6 通过，原持久化、请求 ID 和至少 1900ms 断言保留。初步 SW 假设已被实测排除；故障注入套件原有 `serviceWorkers: block` 保持，完整门禁仍运行独立 SW/privacy 用例。`/tmp/task10-browser-final-targeted.log`、`/tmp/task10-capture-diagnostic.log`、`/tmp/task10-capture-race-green.log`。

## 整分支最终审查修复

审查范围 `6434e478..4a6eb15a` 的结论为 Spec FAIL / Quality CHANGES_REQUIRED：0 Critical、3 Important、0 Minor。原来通过的 988 项 Vitest 与 48 项 Playwright 没有覆盖下列三条路径；本轮逐项先复现，再修复。

1. **真正未分类的答题卡补齐题干后仍不能练习。** `MaterialStore.getQuestion` 现在仅在存储学科为 NULL 时，从当前实际关联的题干来源推导缺失学科。需要同学生 source batch、当前 source hash/提取版本、相同 fragment/asset/role/box/题号/小问；多个支持学科冲突时不选。保持原有 passed/low 学习路径，未知值、failed/unchecked 片段不提升；不写回 `material_question.subject`。因此移走或撤销唯一来源时分类消失，学习摘要同步清除派生分类，原 question/attempt/item 和全部手工答案历史保留。普通转写修改不会把推导结果固化，只有明确学科更正才成为存储权威。10 个回归覆盖强文档、上下文、两方向整页选择、手工答案 pin/历史、学习上下文、冲突/来源/未知值、CAS 与撤销。
2. **旧原图不能供真实答案/批改读取。** 从 `media.ts` 提取原有 `originalSourcePath` 解析，并让 `MaterialUploads.source` 共用：新上传的 `original`、旧直接原图、旧 mobile job 的 `source-original.jpg` 三种布局使用相同 owner/hash/job/media 身份检查。action provider 仍在读取后核对完整 SHA256，保留原大小/像素/图像预算；没有退回 normalized derivative。11 个合成本地 HTTP 协议用例检验旧题真实迁移后的图形答案与作答批改、新上传、损坏 derivative、原图缺失/改写/外来 owner，以及 job ID/hash/media kind/path/owner link 不符时请求前拒绝。
3. **默认 mock 使用域外学科 `math`。** 应用内置的已知合成算术示例改为支持值 `数学`；通过实际默认 provider → extract/reconcile → 显式收录检查可练习。真实模型的未知输出规则保持。

红绿证据：`materialClassification + materialExtraction` 初次 **7 失败/7 通过**（`/tmp/material-final-fix-classification-red.log`），初步修复后 14 通过；移除来源后的学习摘要断言 **4 失败/2 通过**（`/tmp/material-final-fix-projection-red.log`）；补入转写后冲突测试的相关 10 文件运行 **2 失败/190 通过**（`/tmp/material-final-fix-targeted.log`），暴露普通转写固化分类，修复后 classification/learning/v2Correct **38 通过**（`/tmp/material-final-fix-classification-final-green.log`）。`materialActionSources` 初次 **3 失败/8 通过**，包括两种旧布局 ENOENT 和外来 source batch 未拒绝（`/tmp/material-final-fix-sources-red.log`）；共用解析后 **11 通过**（`/tmp/material-final-fix-sources-green.log`）。原测试断言未弱化。

首轮修复全量门禁：`SEL_AI_MODE=mock npm run verify` **exit 0**；typecheck/build 通过，Vitest **80 文件、1010 通过/5 跳过**，Playwright **48 通过/1 跳过**。日志 `/tmp/material-final-fix-verify.log`。它未覆盖随后 scoped review 发现的两项边界；追加修复与新门禁如下。本轮使用合成数据/mock/loopback 协议替身，不证明真实模型准确率；fresh scoped review 由控制器后续发起。

### Scoped review 后的窄范围追加修复

首轮修复范围 `4a6eb15a..e49a6f8` 的独立审查仍为 Spec FAIL / Quality CHANGES_REQUIRED，0 Critical / 2 Important / 0 Minor。默认 mock 的域值问题已关闭；普通补齐和三种原图正常路径已关闭，下面两项交互需要修正。

- **整页分拆不能固化旧页推导的学科。** `assignDocument` 的 split 原来把公开 `q.subject` 写到新题，导致答题卡离开数学题干后仍保存“数学”，后来只补入物理题干也无法恢复。现在只复制 owner-scoped 原题行的原始存储学科；派生值不复制。新增两例覆盖未明确分类/显式更正为化学，真实整页分拆、旧数学页留在原题、无题干时 NULL、随后物理来源、原始存储仍 NULL、撤销恢复原 attempt，以及 stale CAS/后来补题后不安全 undo 拒绝。其他学科持久化调用已审计：学习摘要本来是可更新的投影；matching 使用提取来源；legacy 镜像使用原 Evidence；普通转写不能固化派生值的上轮修复保持。
- **识别出 mobile 来源后，缺失 owner/job link 必须拒绝。** 自然 JPEG 经 `normalizePhoto` 可以字节完全相同；只靠 hash 拒绝 derivative 不足。共享 resolver 现在用当前 owned link、迁移保存的 `sourceAssetId/mobile.jobId` 或 `v2_photo` source/job 记录识别对应 mobile 目录；没有这些映射时，实际匹配目录 ID/源媒体路径的 job metadata 也能识别来源。识别后缺少当前对应学生的 link 即拒绝；其余原有 job/hash/media 校验与 preserved original 读取保持。单纯目录叫 `media` 不构成 mobile 证据：真实直接旧原图位于 generic media、旁边有不相关 job.json 的正例仍能打印读取并执行答案/批改。

红灯：`npx vitest run tests/integration/materialClassification.test.ts tests/integration/materialActionSources.test.ts`，**5 失败/23 通过**，`/tmp/material-final-fix2-red.log`。新增自然字节相同负例覆盖 link 改写/删除、foreign item owner、迁移记录但 job.json 已删、仅 bridge provenance、仅实际 job metadata；答案和批改均零 HTTP，`readSourceBytes` 与 `readFragmentImage` 同样拒绝。绿灯：classification/actionSources/links/print/migration/learning/uploads/v2Print **8 文件、151 通过**，`/tmp/material-final-fix2-green.log`；typecheck 通过，`/tmp/material-final-fix2-typecheck.log`。未弱化原断言。

追加修复最新完整门禁：`SEL_AI_MODE=mock npm run verify` **exit 0**；typecheck/build 通过，Vitest **80 文件、1019 通过/5 跳过**，Playwright **48 通过/1 跳过**，日志 `/tmp/material-final-fix2-verify.log`。本次追加修复只在最终代码上运行一次完整门禁；之后仅更新证据文字。`git diff --check` 通过，19 条 Ruling 逐字保持。下一轮独立 scoped review 尚未发生；不把实现和测试通过写成审查批准。

## 验证环境与命令（Task10 修复前记录）

Linux 6.18.55，Node v24.19.0，Chromium/headless，手机视口 390×844、桌面 1280×900。所有命令在 `/workspace/work/material-linking`，真实模型配置不参与验证。

| 命令 | 结果与证据 |
| --- | --- |
| `npx vitest run tests/integration/materialLinks.test.ts -t 'keeps the answer-card identity'` | RED：1 失败，45 未选；2 题而非 1。`/tmp/task10-manual-first-red.log` |
| `npx vitest run tests/integration/materialLinks.test.ts -t 'first stem completion\|previously removed'` | RED：1 失败/2 通过；反向整页绑定后 stale。`/tmp/task10-first-completion-red2.log` |
| `npx vitest run tests/integration/materialLinks.test.ts -t 'direct .* reconciliation'` | RED：2 失败；context/document 直接补拍仍是旧 stale 版本。`/tmp/task10-direct-red.log` |
| `npx vitest run tests/integration/materialLinks.test.ts tests/integration/materialIsolation.test.ts` | 当时 53 通过（51 + 2），`/tmp/task10-links-isolation.log`。之后增加 foreign upload 引用断言，由最终门禁覆盖 |
| `npx playwright test tests/e2e/materialJourney.spec.ts` | 首次缺题干入口测量 RED；长摘要溢出 RED 后，3 旅程通过，`/tmp/task10-journeys-run4.log`。之后增强指标/同标签/上传引用断言，由最终门禁覆盖 |
| `npx vitest run tests/integration/materialMigration.test.ts tests/integration/materialLearning.test.ts` | 修复后 26 通过；`/tmp/task10-migration-green.log` |
| `npx playwright test tests/e2e/materialJourney.spec.ts tests/e2e/materialCapture.spec.ts` | 当时 24 通过/2 测试准备竞态失败；三条旅程全部通过。随后目标文档等待修复，最终门禁覆盖全部 26 |
| `npx playwright test tests/e2e/materialCapture.spec.ts -g 'never calls a local\|429 respects' --repeat-each=3` | 6 通过；`/tmp/task10-capture-race-green.log` |
| `npm run typecheck` | 通过，`/tmp/task10-typecheck2.log`；最终门禁再次覆盖 |
| `SEL_AI_MODE=mock npm run verify`（首次） | typecheck/build 通过；Vitest 980 通过/5 跳过/8 失败，均为旧迁移不变断言；未进入 E2E。`/tmp/task10-verify-initial-red.log` |
| `SEL_AI_MODE=mock npm run verify`（修复后最终） | exit 0；typecheck/build 通过；Vitest 78 文件、988 通过/5 跳过（993）；Playwright 48 通过/1 跳过（49），包含全部 23 capture、3 新旅程及 SW/privacy。日志 `/tmp/task10-verify-final.log` |
| `git diff --check` | 通过；最终文档与精确 staged diff 已检查 |

早期失败还包含夹具/断言校正：fixture 学科使用真实域值“数学”；匿名 GET 是 200 登录页而非 JSON 401；回传日期应选今天而非列表首个旧日；同账号恢复和跨账号草稿清除不是同一语义。这些没有通过修改生产认证、放宽历史保护或弱化既有测试来解决。

## 拒绝矩阵与原始证据

`tests/integration/materialIsolation.test.ts` 使用真实父网关与独立 worker，覆盖全部新增材料 GET/POST 路径、图片与片段版本、题目/答案历史/粘贴记录、整页候选/目标、关联/撤销、手工/导入/生成/选择、批改/重试/收录、上传 capture/document/question/attempt 引用。无会话 GET 只返回登录页（200，无材料）；无会话 JSON POST 401；跨站 POST 403；旧 namespace 409；另一学生资源读取/写入 404。外来答案 ID 400；选择不存在作答的批改返回 200 的明确 skipped 结果、jobs=[]，不处理别人的作答。攻击前后 A 的材料/答案/作答/任务/学习记录快照相同。

额外检验 40000 个中文手工答案通过真实父路由，40001 字/201 字来源说明 400、过期 CAS 409、超过 512KB 413。原图、题目和完整打印包通过浏览器上下文再检验。打印与回传页对另一学生 404，跨站打印 POST 403；旧 `/v2` 对全新和混合包的完整拒绝矩阵在 `materialLegacyApi.test.ts`，最终全门禁包含它，不能把新包裁成仅旧题返回。

私有本地证据目录 `/tmp/task10-material/`：`isolation-matrix.json`、`print-isolation.json`、`journey-metrics.json`、`same-page-metrics.json`；截图包括 missing-stem、whole-page-candidates、sources、long-number、long-label、extraction-failure、answer-retry、grade-retry、print、mixed-print、switched-account。实际用 image viewer 检查过手机和桌面截图，确认可换行、入口可找、原图候选/来源/失败重试明确。截图只含合成内容，无邀请码或 token；不纳入仓库。

## 点击与时间的真实含义

主旅程记录实际导航请求、滚动事件与 POST 路径；三次拍完后抵达状态各 1 次站内导航。`requiredLabelClicks=0`、`perQuestionConfirmationClicks=0`、`wholedocumentChoiceSubmissions=1`、`postcaptureStatusNavigation=1`。系统选图单独记 3 次。Task10 完整门禁（本轮审查修复前）记录：脚本 elapsed 4267ms、scrollEvents 3、navigationRequests 34、关联纠正 0、显式答案选择 1；这是有等待/截图的自动化时间，**不是人主动操作时间、真机速度、真实识别准确率或错关联率**。数值来自最终运行的原始 JSON。

无标签同页旅程也在任何可选标签修改前记录必需标签/逐题确认均 0；Task10 脚本 elapsed 12123ms；后续专门测试一次可选长标签 API 写入、一次“另记作答”调整和三个失败重试。与主旅程指标分开，不把可选纠正掩饰成必需流程，也不把初始化/合成系统动作计为站内点击。

## 尚未验证与保守边界

- 真实模型的提取、关联、答案和批改准确率，真人主动时间，真机 Safari/安卓相机、真实纸张打印与真实学生跨周使用均未在本轮验证。无生产部署、真实数据清理、GitHub CI/线上验收声明。
- 预 fingerprint 的历史上传保留 NULL 原始请求身份，无法证明原请求完全一致的重放返回 `409 upload_identity_unavailable`。服务器照片仍保留，可查看已存材料并删除本机待传项；不要求重新拍照、不无限重试。
- 未知学科不猜成数学/物理/化学；跨多个片段的转写修改仍按一次一个真实片段处理。图形不完整或来源校验失败不能当完整证据。
- 批改只由显式请求触发，不更改原作、学生反思或掌握状态；无明确可支持评分的细则时不给精确分数。模拟结果与物理/教学效果分开报告。
- 新打印内部 manifest 与来源 basis 不进入旧公共 PrintSnapshot JSON；web 明确用 all，服务默认 legacy。历史 ready 快照保持不可变，不能用现代材料补全旧快照或绕过显式答案 pin。

## 执行裁定原文（持久化副本）

下列逐字保留 `progress.md` 全部 `Ruling:` 行，避免清理忽略的编排目录后丢失实现边界。

Ruling: Use an isolated worktree at /workspace/work/material-linking on codex/material-linking — execution is authorized, the current checkout is a normal work branch, and a non-hidden path avoids the documented legacy PDF dotfile issue — cost if wrong: local branch/worktree relocation only; no production effect.

Ruling: Reproduce the skill's workspace, brief and diff-package operations with local scripts — the published support-resource reads failed and no local skill files are exposed — cost if wrong: orchestration metadata may need correction; preserve task/review gates and commit ranges.

Ruling: Treat the approved material-linking spec as overriding old AGENTS language that forbids AI grading, only for explicitly requested grading — this is the user's accepted feature scope — cost if wrong: feature scope rework; reflection/mastery safeguards remain mandatory.

Ruling: Keep legacy API serializers/routes compatible while the new web capture path uses material IDs — the new flow cannot fabricate RecognitionJob IDs; existing upload format compatibility tests must still exercise real normalization — cost if wrong: web/legacy boundary adjustments, guarded by legacy response regression tests.

Ruling: Add MaterialJobs.request<T>(jobId, stageKey, invoke(signal)) checkpoints and optional MaterialStore injection for cloud assembly — the planned handler signature alone cannot meter each actual model request, and legacy-only fixtures must not open a new global DB — cost if wrong: provider binding/lifecycle rework; preserve public existing API. Task 3 must bind a per-job executor (no mutable global job context), route each actual call/chunk plus validation through it, and reuse validated completed results. Task 7 answer generation within grading should use inline stages rather than await a queued child behind the same serial scheduler.

Ruling: Use an owner-workspace append-only link-event token for relink/undo CAS (export linkRevision), while assignDocument CAS uses the asset revision — the fixed API has one expectedRevision and must reject overlapping source/target client changes — cost if wrong: unrelated link edits may cause a safe 409/retry; paid answer/grade basis remains dependency-specific and must not include this coarse token. Task5 must consume the documented link token, not question revision. Task4 retains redirection aliases in owner-scoped material_legacy_map source_kind=question_alias without deleting original history, with learning-binding conflict safeguards.

Ruling: Resolve supplementary-diagram eligibility through an additive effectiveFragmentCheck helper backed by Task3's durable locate/read/verify checkpoints, while preserving raw fragment history — low plus missing_diagram alone cannot prove that the original individual verification passed — cost if wrong: unavailable/changed checkpoint provenance conservatively leaves a fragment low; no uncertain evidence promotion. Require exact source/candidate/region/role/scope/text identity and a genuinely linked passed diagram. Tasks6/7/9 must consume this effective check as appropriate. Unidentified diagram scopes do not establish coverage automatically.

Ruling: Keep two pre-existing provisional records unresolved when either has answer/grade history rather than transferring immutable result ownership during Task4 merging — aliasing only the fragments could hide results owned by the losing question — cost if wrong: these exceptional merges need explicit later handling; both records/results remain accessible, and ordinary supplement attachment to one existing answered question must still work. Expose a concrete pending reason for downstream UI and retain regression coverage.

Ruling: Amend the earlier assignDocument CAS ownership: use a separate additive per-asset link/metadata revision, not material_asset.revision used by extraction — incrementing extraction revision on manual relink would discard a valid in-flight result and strand a stale job that Task2.retry cannot resume — cost if wrong: one additive schema column/helper and downstream token naming; no source identity weakening. Task4 is authorized to update schema plus tests, preserve extraction source guard, and verify stale page confirmation is rejected while unchanged-source extraction survives manual linking. Relink/undo workspace event CAS remains as decided.

Ruling: Interpret the plan's no-attribution-evidence pending rule as applying to cross-image ambiguity, not complete uniquely associated standalone pages — mandatory document confirmation for an otherwise complete same-image question conflicts with the approved optional-label/local-association flow — cost if wrong: later cross-page supplements still need explicit document attribution; never guess their identity from this local exemption.

Ruling: Preserve old picker-era photoUpload E2E through explicit test-only legacy fixture injection while production capture defaults to materials — the existing tests hardcode the legacy route/redirect but still provide valuable real normalization coverage — cost if wrong: fixture maintenance and an extra new-path compatibility test; never expose a production user/query switch, weaken auth/isolation checks, or treat legacy tests as proof of new queue behavior. Task5 new materialCapture must verify real normalization and no-JS material upload separately.

Ruling: Authorize bounded upload/schema support for an immutable original upload-hints/request fingerprint separate from editable current hints — exact same-UUID replay must acknowledge after label/document-context edits without accepting a different original request or overwriting edits — cost if wrong: additive storage/migration and focused upload-route regression; never weaken ownership, byte/capture validation or fabricate unavailable historical request provenance.

Ruling: Preserve batch-pasted answers as imported text with fragmentIds=[] and an owner/document-scoped immutable original text/import relation, clearly labeled 粘贴导入 — no actual photo exists, so manufacturing image coordinates would falsify provenance — cost if wrong: text-import projection/UI adjustment; photographed imports still require real fragment/link references and all source/version history remains.

Ruling: Exempt only the validated same-owner/same-question still-running grade parent from the adopted-answer invalidation caused by its own inline AI answer creation — otherwise every no-reference grade request would stale itself — cost if wrong: Task7 helper/transaction integration adjustment; external stem/link/work/selection changes must still stale or reject it, and Task7 must recheck frozen dependencies and set the new grade basis in the helper persistence transaction.

Ruling: Permit narrow merge of a pure automatically projected photo-reference provisional question into one compatible stem-bearing target, keeping target identity and independent history — eager Task6projection otherwise blocks ordinary late/early answerpage association — cost if wrong: bounded matching/history adjustment; provisional must have no learningbinding/work/grades/explicitselection and all historical answers must be proven auto projections. Reproject movedrealfragments, retain oldstaleprojection history through owner-scoped alias-family history reads and undo. Other manual/AI/grade/ambiguous historyguards remain.

Ruling: Initially permit numericAIscore only from frozen passedstem/question fragments containing explicit criterion-and-point rubric, not printedtotal alone or teacher deductions — existinggradeBasis covers these realrubricdependencies; other casesreturn score=null — cost if wrong: laterbroader rubric-source support; preserveteacher marks separately and test in-flight/completedrubricedits stalegrade. This is a conservative supported-scope limit, not proof of realgradingaccuracy.

Ruling: Keep mappedlegacy learning/correction authority in its real originalEvidence andmobile_item_link/jobId while preserving material supplements as separate genuine fragmentversions on the sameitem — inventing a widenedfullEvidence would falsify source/verification coverage — cost if wrong: source-awareweb/printadapteradjustment; mirror successfullegacytextcorrections to originalmappedtranscripts withoutsource/checkmutation, visiblylink supplementmaterials, andTask9mustassembleactualsupplement sources/currentselectedreferences for newwebsnapshots whileoldready snapshots/APIshapesremain.

Ruling: Persist Task9 per-item print basis/source manifest/exact answer versions in a small separate internal table, leaving the public PrintSnapshot JSON shape unchanged — manifest is required for whole-prepare/restart consistency but legacy API compatibility forbids exposing new internal source fields — cost if wrong: bounded print persistence migration; oldready snapshot bytes stay unchanged. Scope defaults legacy; web explicitly all. Printed dependency basis covers actual same-source redaction regions (including neighboring questions), not unrelated labels. Historical preparing rows without a manifest must be handled conservatively; explicit retry after changed basis cannot mix old partials with new inputs.

Ruling: Permit a unique compatible pure question/diagram supplement with no item, answers, grades, attempts or explicit selection to merge into a stem-missing history-bearing answer-card identity, preserving that identity, original attempt IDs and every result/history record — the user explicitly approved entering a correct answer before the stem is photographed, and blanket history refusal breaks that core journey — cost if wrong: bounded matching/dependency/undo adjustment; never merge two independent histories or fabricate evidence. A manually provided answer created with genuinely empty stem dependencies may remain valid through its first compatible stem completion on the same history identity only; known-stem replacement, removal/re-add, ownership/link changes and other result types retain normal invalidation. Require concrete negative/undo regressions and durable first-completion provenance if needed.
