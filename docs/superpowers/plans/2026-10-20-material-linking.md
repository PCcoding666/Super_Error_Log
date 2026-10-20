# 学习材料收录与跨图关联 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 学生可以任意顺序拍题目、作答、批改和答案，由系统关联、保留来源，再按需批改及收进错题本。

**Architecture:** 在现有每学生独立 SQLite/worker 内增加材料关联层，允许无题干的临时题记录；不把答题卡伪装成完整的单图 `Evidence`。材料任务复用现有识别服务的执行队列与准入，网页通过新的学习来源适配器复用错题本、复盘、练习和打印，旧 API 保持原协议。

**Tech Stack:** Node >= 24、TypeScript ESM、Express 5、React 19 SSR（无 hydration）、node:sqlite、sharp、浏览器 IndexedDB、Vitest、Playwright。

**Spec:** [已确认设计](../specs/2026-10-20-material-linking-design.md)。用户于 2026-10-20 回复“开始！”，进入实施计划阶段；本文件尚未执行。

## Global Constraints

- 网页 `/s/` 为本轮交付入口；iOS 不在本轮改造范围。不新增框架或第三方依赖。
- 不要求固定拍摄顺序、先选材料类型、先分组或逐题框选。标签是可跳过的提示；采集批次不等于试卷。
- 上传保持 HEIC/JPEG 兼容、最长边 4096、15 MiB 服务端文件上限、40 M 像素输入上限、现有超时/重试/幂等约束。
- 只有服务器确认持久化后才能显示照片已保存。页面关闭可能暂停上传，重新打开后恢复未完成项。
- 继续使用现有独立学生空间与访问校验；服务端状态不依赖本周 cookie。
- 原始材料、作答、订正、不同作答次数及答案来源分别保留；AI 结果不能冒充老师批改或已核验答案。
- “未批改”是状态；“帮我批改”是操作。拍照、标签、手工答案和刷新均不自动触发付费批改。
- 学生本人提交反思；批改不更新掌握度；延迟独立重做规则及家长聚合边界不变。
- 缺失、关联不确定、未检查或过期的材料不当作已核验证据；保留当前 v2 的原图及低置信打印警示，不加逐题确认门槛。
- 旧题 ID、媒体、学习记录、历史打印快照保留；迁移不重跑真实照片。真实模式缺配置直接报错，不降级 mock。
- 本计划执行使用合成数据/mock 或本地协议替身；完整检查为 `SEL_AI_MODE=mock npm run verify`。真实模型准确率、真机体验与发布分别报告。
- 本地实现及验证不包含生产部署、真实数据清理或发送外部消息。

## Review Focus

1. 服务器已收图但响应丢失，浏览器恢复后重传：一份材料、同一任务、真实保存状态。归属 Task 2、5。
2. 两份同名试卷都有“12(1)”，同时出现第二次作答：不串卷、不覆盖第一次作答。归属 Task 4。
3. AI 运行中改关联/撤销，随后旧调用返回：旧结果保留为过期记录，不能覆盖现有题。归属 Task 4、6、7。
4. IndexedDB 空间不足、同源账号切换及另一标签页仍在上传：不假报已保存，不把旧草稿传给新账号。归属 Task 5、10。
5. 题干跨页且后到答案与 AI 冲突，题已打印：新视图提示冲突，旧打印文件及作答依据不变。归属 Task 6、9。

---

## 文件边界与共享契约

| 文件 | 职责 / 拥有任务 |
| --- | --- |
| `src/materials/contracts.ts`、`schema.ts`、`store.ts`、`legacy.ts` | 领域类型、事务、迁移、历史来源映射；Task 1 |
| `src/materials/uploads.ts`、`jobs.ts` | 持久化收图、幂等、阶段预算、恢复；Task 2 |
| `src/materials/provider.ts`、`extraction.ts` | 模型边界、真实/mock 实现、片段及来源验证；Task 3 |
| `src/materials/matching.ts`、`links.ts`、`queries.ts` | 候选、自动/人工关联、撤销、题目汇总；Task 4 |
| `src/web/uploadQueue.ts`、`materialsRouter.ts`、`views/materials.tsx` | 浏览器草稿与材料路由/页面；Task 5 |
| `src/materials/answers.ts`、`grading.ts` | 答案来源与版本、按需批改；Task 6、7 |
| `src/learning/contracts.ts`、`sources.ts`、`queries.ts` | 统一学习来源与查询，保留旧协议边界；Task 8 |
| `src/materials/learning.ts`、`media.ts` | 唯一错题映射、多源裁图与打印输入；Task 8、9 |
| 现有 `src/mobile/service.ts`、`router.ts`、`cloudAssembly.ts` | 队列及生命周期装配，不另外开无容量限制的执行器；Task 2 |
| 现有 `src/web/router.ts`、`photoUpload.ts`、`assets.ts`、`session.ts`、`state.ts`、`weekPlan.ts` 及相关 views | 新入口、旧闭环接入、上传兼容、同意文案；Task 5、8 |
| 现有 `src/ai/`、`src/config.ts`、`src/v2/` | 新阶段配置、文本上下文适配、旧服务复用；Task 3、8、9 |

在 `src/materials/contracts.ts` 定义以下公共类型；其他任务不得另造同义状态或用前端传入的学生 ID 选择数据库。ID 使用现有 `newId`，浏览器上传/请求幂等键使用 UUID。

```ts
import type { Box } from '../media/images.js';
import type { StageRun } from '../ai/chatClient.js';
type MaterialRole = 'question' | 'diagram' | 'student_work' | 'correction'
  | 'teacher_mark' | 'reference_answer' | 'unknown';
type CaptureHints = {
  roles?: MaterialRole[]; marking?: 'unmarked' | 'marked' | 'partial';
  label?: string; documentId?: string; questionId?: string; attemptId?: string;
};
type SourceRegion = { assetId: string; fragmentId: string; revision: number; box: Box; sourceHash: string };
type Fragment = SourceRegion & {
  role: MaterialRole; text: string; number: string | null; subpart: string | null;
  page: number | null; order: number; requiresDiagram: boolean;
  check: 'passed' | 'low' | 'failed' | 'unchecked'; uncertainties: string[];
};
type DocumentClues = { title: string | null; subject: string | null;
  date: string | null; printedCode: string | null; page: number | null };
type Extraction = { assetId: string; revision: number; document: DocumentClues;
  fragments: Fragment[]; warnings: string[]; runs: StageRun[] };
type MaterialJobKind = 'extract' | 'answer' | 'grade';
type JobTicket = { id: string; kind: MaterialJobKind;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'stale' };
type ReferenceAnswer = {
  id: string; questionId: string; subpart: string | null; revision: number;
  source: 'imported' | 'manual' | 'ai'; text: string; claimedSource: string | null;
  fragmentIds: string[]; basisKey: string; stale: boolean; run: StageRun | null;
};
type Grade = { id: string; attemptId: string; answerIds: string[]; basisKey: string;
  result: 'correct' | 'partial' | 'incorrect' | 'uncertain';
  findings: { fragmentIds: string[]; text: string }[];
  score: { earned: number; total: number; rubricFragmentIds: string[] } | null;
  stale: boolean; run: StageRun };
type QuestionBundle = {
  id: string; documentId: string | null; revision: number; basisKey: string;
  number: string | null; subject: string | null; tags: string[];
  stem: Fragment[]; attempts: { id: string; revision: number; fragments: Fragment[] }[];
  teacherMarks: Fragment[]; answers: ReferenceAnswer[]; grades: Grade[];
  missing: ('stem' | 'diagram' | 'work')[]; unresolved: string[];
  answerConflict: boolean; itemId: string | null;
};
type LinkTarget = { questionId: string; attemptId: string | null };
type LinkChange = { id: string; questionId: string; revision: number };
type BatchRequest = { requestId: string; questionIds: string[]; documentId?: never }
  | { requestId: string; documentId: string; questionIds?: never };
type BatchAction = { jobs: JobTicket[]; skipped: { questionId: string; reason: string }[] };
```

`basisKey` 是相关题干/图形、片段来源及版本、链接版本、所选作答/答案版本的确定性摘要，不含拍摄顺序和展示标签。答案生成只依赖题干/图形及其链接；批改另外依赖作答和所用答案。操作保存各自依赖集合，不用整份材料的一个版本使所有题无差别失效。

测试片段以下列出的测试名称及断言为最小验收；各文件沿用仓库临时数据库/HTTP fixture 模式完成 setup，不访问生产。每个 Task 完成一轮失败→实现→通过→提交，不能把所有测试留到最后。

### Task 1: 可补全的数据层及幂等旧数据映射

**Files:** Create `src/materials/contracts.ts`, `src/materials/schema.ts`, `src/materials/store.ts`, `src/materials/legacy.ts`; Modify `src/db/connection.ts`; Test `tests/integration/materialStore.test.ts`, `tests/integration/materialMigration.test.ts`.

**Interfaces:** `migrateMaterials(db: DatabaseSync): void`; `backfillLegacyMaterials(db: DatabaseSync): { mapped: number }`; `MaterialStore(db: DatabaseSync, studentId: string)` exposes `transaction<T>(fn: () => T): T`, `createCapture(requestId: string): { id: string }`, `getQuestion(id: string): QuestionBundle | null`. `DatabaseSync` comes from `node:sqlite`，`QuestionBundle` 是本任务类型。

- [ ] **Step 1: 建立失败测试。** 用已存在的单图错题、反思、打印包及回传记录建旧库 fixture；记录原 IDs、行数、媒体摘要。新增材料空题允许 `stem=[]`，不是创建空 `Evidence`。

```ts
// it('migrates twice without replacing legacy learning or running AI')
expect(secondMigration.mapped).toBe(0);
expect(afterLegacyRows).toEqual(beforeLegacyRows);
expect(afterMediaHashes).toEqual(beforeMediaHashes);
// it('persists a provisional question without a stem')
expect(reopenedQuestion.stem).toEqual([]);
expect(reopenedQuestion.missing).toContain('stem');
```

- [ ] **Step 2: 运行红灯。** `npx vitest run tests/integration/materialStore.test.ts tests/integration/materialMigration.test.ts`；预期新模块缺失或迁移/空题断言失败。
- [ ] **Step 3: 实现 schema 和 store。** 新增 `material_workspace`、`material_capture`、`material_document`、`material_asset`、`material_fragment`、`material_question`、`material_attempt`、`material_link_event`、`material_answer`、`material_grade`、`material_job`、`material_item_link`、`material_legacy_map`。workspace 保存当前学生稳定随机的 draftNamespace；`material_asset` 引用 `source_asset`，capture 引用 `source_batch`；不修改既有来源行。链接事件保存前后目标及版本，片段/答案保留历史版本。表内 owner 固定为当前 worker 学生；跨对象引用同时验证 owner。唯一约束包括上传请求键、任务请求键、旧来源映射键及题目→错题映射。事务同步执行，模型/文件 I/O 不跨 SQLite 事务。
- [ ] **Step 4: 实现旧数据映射。** 从 `mobile_item_link`、`evidence_record` 及 `source_asset` 映射已有片段、作答和题，不重新识别、不根据题号合并历史题；保留 `itemId`。缺失或无效历史证据保留可追溯待处理状态，不阻止其他题迁移。启动在 bridge schema 就绪后执行；不引入第二个全局 DB。
- [ ] **Step 5: 验证并提交。** 重跑 Step 2（PASS）和 `npm run typecheck`；旧 fixture 清理需遵守新增外键，使用临时库而非删除真实目录。
  `git add src/materials/contracts.ts src/materials/schema.ts src/materials/store.ts src/materials/legacy.ts src/db/connection.ts tests/integration/materialStore.test.ts tests/integration/materialMigration.test.ts`
  `git commit -m "feat(materials): persist source links and migrate legacy records"`

### Task 2: 保存成功即可靠、可恢复的材料任务

**Files:** Create `src/materials/uploads.ts`, `src/materials/jobs.ts`; Modify `src/mobile/service.ts`, `src/mobile/router.ts`, `src/mobile/cloudAssembly.ts`; Test `tests/integration/materialUploads.test.ts`, `tests/integration/materialJobs.test.ts`.

**Interfaces:** consumes `MaterialStore`; produces `MaterialUploads(store: MaterialStore, jobs: MaterialJobs, admission: AdmissionController | null)`，方法 `save(input: { captureId: string; uploadId: string; filename: string; bytes: Buffer; hints: CaptureHints }, reservation?: AdmissionReserve): Promise<{ assetId: string; job: JobTicket; created: boolean }>`。`MaterialJobs(store: MaterialStore, scheduler: MobileRecognitionService, admission: AdmissionController | null)` exposes `register(kind: MaterialJobKind, run: (jobId: string, signal: AbortSignal) => Promise<void>): void`, `enqueue(kind: MaterialJobKind, targetId: string, requestId: string, basisKey: string, options?: { reservation?: AdmissionReserve }): JobTicket`, `retry(jobId: string, requestId: string): JobTicket`, `resume(): Promise<void>`, `stop(): Promise<void>`。`AdmissionReserve` 使用现有 `src/mobile/router.ts` 类型；新上传把准入预约传给 save→enqueue，只有成功接管才置 handoff，幂等重放不接管，由现有 finally 归还。scheduler 新方法为 `enqueueExternalWork(key: string, run: (signal: AbortSignal) => Promise<void>): 'queued' | 'already_queued' | 'stopped'`。

- [ ] **Step 1: 建立失败测试。** 同一上传键相同 bytes 重放、同键不同 bytes、保存后响应丢失、重启恢复、容量满/中断、停止时尚有外部任务。断言同键异内容返回 409，队列满返回可重试 429，不生成第二份材料。

```ts
// it('replays a committed upload after its response is lost')
expect(retry.assetId).toBe(first.assetId);
expect(retry.job.id).toBe(first.job.id);
expect(retry.created).toBe(false);
// it('resumes only unfinished work without resetting request budgets')
expect(attemptsAfterRestart).toBe(attemptsBeforeRestart);
expect(successfulExtractionCalls).toBe(1);
expect(admissionOccupancyAfterStop).toBe(0);
```

- [ ] **Step 2: 运行红灯。** `npx vitest run tests/integration/materialUploads.test.ts tests/integration/materialJobs.test.ts`，预期模块缺失或重传/恢复断言失败。
- [ ] **Step 3: 实现上传事务边界。** 复用服务端归一化、`acquireUploadAdmission`、`withImage` 和错误映射。文件先写临时路径、原子提交，再提交 DB；回复前原图和任务均已持久化。清理无 DB 引用的未完成临时文件，不能删除学生原图。内容 hash 用于文件复用和证据去重，不等于文档/作答身份；用户明确的新作答上下文不能被 hash 吞掉。已保存材料的标签修改另走版本化接口，不拿旧上传键改内容。
- [ ] **Step 4: 扩展现有 drain 的外部工作分支。** 不假造 `RecognitionJob.questions`；外部工作异常由 `MaterialJobs` 记录，不进入旧 job 的 `failStorage`。一个共享执行队列、停止 signal 和容量核算；上传预占容量只移交一次，答案/批改任务也要预占共享容量，恢复按未终态任务计算占用。持久化每阶段实际请求预算，沿用每轮最多 3 次及 2s/8s 退避、不可恢复错误分类；先落预算再发请求。显式 retry 只重试失败阶段、以新 requestId 幂等开可恢复轮次；不可恢复的坏文件提示补拍，刷新不重置预算。无 handler 不执行，装配注册齐全后 resume；watchdog 纳入未终态材料任务。批次容量不足保留未受理题及明确原因，不丢题。
- [ ] **Step 5: 验证并提交。** Step 2 PASS；再运行 `npx vitest run tests/integration/mobileAdmission.test.ts tests/integration/mobileRecovery.test.ts tests/integration/mobileRetryBudget.test.ts tests/integration/singleProcessAssembly.test.ts`。
  `git add src/materials/uploads.ts src/materials/jobs.ts src/mobile/service.ts src/mobile/router.ts src/mobile/cloudAssembly.ts tests/integration/materialUploads.test.ts tests/integration/materialJobs.test.ts`
  `git commit -m "feat(materials): reuse durable upload admission and recognition scheduling"`

### Task 3: 提取多角色片段，不先要求学生选题

**Files:** Create `src/materials/provider.ts`, `src/materials/extraction.ts`; Modify `src/ai/chatClient.ts`, `src/config.ts`, `src/v2/aiConfigGuard.ts`, `src/mobile/cloudAssembly.ts`, `.env.example`; Test `tests/integration/materialExtraction.test.ts`, `tests/integration/materialProvider.test.ts`.

**Interfaces:** `MaterialProvider.extract(input: { assetId: string; revision: number; bytes: Buffer; hints: CaptureHints }, signal: AbortSignal): Promise<Extraction>`；同一 provider 后续增加 `answer(bundle: QuestionBundle, signal: AbortSignal): Promise<{ text: string; run: StageRun }>` 和 `grade(bundle: QuestionBundle, attemptId: string, answers: ReferenceAnswer[], signal: AbortSignal): Promise<Omit<Grade, 'id' | 'stale'>>`。`extractMaterial(store: MaterialStore, provider: MaterialProvider, jobId: string, signal: AbortSignal): Promise<void>` 注册为 extract handler。

- [ ] **Step 1: 建立失败测试。** 合成一页同时含题干、作答、订正、老师批注和参考答案，以及仅答题卡、缺图和越界坐标响应；用本地 HTTP 替身检查真实 provider 请求/响应协议及取消。片段角色不是整张图片的互斥分类。

```ts
// it('extracts mixed roles without promoting a label to evidence')
expect(roles).toEqual(expect.arrayContaining(['question', 'student_work', 'reference_answer']));
expect(unmarkedPhotoTeacherMarks).toEqual([]);
// it('rejects invented source references and leaves incomplete material saved')
expect(invalidReferenceJob.state).toBe('failed');
expect(savedAssetExists).toBe(true);
expect(answerSheetExtraction.fragments.filter(f => f.role === 'question')).toEqual([]);
expect(answerSheetExtraction.fragments.some(f => f.role === 'student_work')).toBe(true);
```

- [ ] **Step 2: 运行红灯。** `npx vitest run tests/integration/materialExtraction.test.ts tests/integration/materialProvider.test.ts`；预期新 provider/验证器缺失。
- [ ] **Step 3: 实现真实与确定性 mock provider。** 复用 `ChatClient` 的认证、图像/token/响应大小限制、超时、abort 和 `beforeRequest` 预算钩子；新增 `material_extract`、`material_verify`、`material_answer`、`material_grade` 模型阶段及 env 映射，真实配置缺失启动失败。extract 先定位角色/题号/小问，再对候选提取并核验覆盖与文本；请求拆分按现有图像/token 限额，不能把整本卷子塞进一次调用。验证 asset/hash/box、引用存在、角色兼容、题号结构、页序和必要图形；只将通过检查的片段置 passed。材料中的“忽略指令”等文字始终视为材料内容。
- [ ] **Step 4: 持久化结果并触发关联。** 成功阶段不因一个片段失败重跑整图；保留低置信片段、原图及不确定原因。提取只发现题和证据，不自行生成正确答案或判整卷对错；批改痕迹不存在则不捏造老师结论。Task 4 的关联入口就绪后在同一工作阶段调用。
- [ ] **Step 5: 验证并提交。** Step 2 PASS，`npm run typecheck`，断言 mock 不联网、真实模式不回退 mock。
  `git add src/materials/provider.ts src/materials/extraction.ts src/ai/chatClient.ts src/config.ts src/v2/aiConfigGuard.ts src/mobile/cloudAssembly.ts .env.example tests/integration/materialExtraction.test.ts tests/integration/materialProvider.test.ts`
  `git commit -m "feat(materials): extract grounded fragments from mixed learning materials"`

### Task 4: 自动关联、一次确认归属、改绑与撤销

**Files:** Create `src/materials/matching.ts`, `src/materials/links.ts`, `src/materials/queries.ts`; Modify `src/materials/extraction.ts`, `src/materials/store.ts`; Test `tests/integration/materialLinks.test.ts`.

**Interfaces:** `reconcileAsset(store: MaterialStore, assetId: string): { linked: number; pending: string[] }`; `assignDocument(store, input: { assetId: string; documentId: string; expectedRevision: number }): LinkChange[]`; `relink(store, input: { fragmentIds: string[]; target: LinkTarget; expectedRevision: number }): LinkChange`; `undoLink(store, changeId: string, expectedRevision: number): LinkChange`；这里 `store` 均为 `MaterialStore`。`readQuestion(store: MaterialStore, questionId: string): QuestionBundle | null`。

- [ ] **Step 1: 建立失败测试。** 无标签同页、先答题卡后题干再隔日答案、反向顺序、两卷同号同标签、跨页小问、第二次作答、提取重试、两个客户端同时改绑。给自动合并用例提供明确的唯一印刷卷号或用户 documentId；另设完全没有归属证据的用例必须待关联。

```ts
// it('completes the same provisional question in either capture order')
expect(after.id).toBe(before.id);
expect(after.attempts[0].fragments).toEqual(expect.arrayContaining(originalWork));
// it('does not merge same-number papers or a repeated attempt')
expect(distinctDocumentQuestionIds.size).toBe(2);
expect(repeatedQuestion.attempts).toHaveLength(2);
// it('rejects a stale relink and preserves the event needed for undo')
expect(staleRelinkStatus).toBe(409);
expect(afterUndoTarget).toEqual(originalTarget);
```

- [ ] **Step 2: 运行红灯。** `npx vitest run tests/integration/materialLinks.test.ts`；预期关联函数缺失或身份/撤销断言失败。
- [ ] **Step 3: 实现保守自动关联。** 强归属证据（用户明确文档、唯一印刷卷号，或能排除所有其他候选的组合文档线索）+ 完整题号/小问兼容 + 唯一候选 + 无内容/作答冲突，才自动链接。标题、自由标签、同批拍摄和模型 confidence 均不能单独成为强证据。同图共现可确定该图内题干与作答的局部关系。待补题保持稳定 ID；补充多个临时记录确需合并时保存重定向别名，优先保留已有学习记录绑定，有两个不同学习绑定则要求人工处理，不能直接丢一个。
- [ ] **Step 4: 实现事务化人工关联和撤销。** 文档确认作用于整页，仅关联仍唯一的题；再次作答有新 attempt，显式 `attemptId` 才是强“补到这次作答”上下文。跨日补拍不能凭日期自动判新作答。版本 CAS 拒绝过期写入，撤销新增反向事件，不能删历史事件或覆盖另一客户端后续修改。修改相关链接使依赖旧 basis 的答案/批改过期，并取消未执行任务；运行中返回须再次比较 basis。
- [ ] **Step 5: 验证并提交。** Step 2 PASS，运行 Task 1–3 的 `material*.test.ts` 定向集合及 typecheck。
  `git add src/materials/matching.ts src/materials/links.ts src/materials/queries.ts src/materials/extraction.ts src/materials/store.ts tests/integration/materialLinks.test.ts`
  `git commit -m "feat(materials): link documents and attempts with reversible decisions"`

### Task 5: 连续拍照、多选、可选标签和草稿恢复

**Files:** Create `src/web/uploadQueue.ts`, `src/web/materialsRouter.ts`, `src/web/views/materials.tsx`; Modify `src/web/router.ts`, `src/web/photoUpload.ts`, `src/web/assets.ts`, `src/web/session.ts`, `src/web/views/today.tsx`, `src/studentHost/router.ts`; Test `tests/integration/materialRoutes.test.ts`, `tests/e2e/materialCapture.spec.ts`; Modify `tests/e2e/studentHostServer.ts`, `src/studentHost/worker.ts` 的 synthetic fixture 注入。

**Interfaces:** `createMaterialsRouter(options: { store: MaterialStore; uploads: MaterialUploads; jobs: MaterialJobs; draftNamespace: string; admission: AdmissionController | null }): Router`；身份/CSRF/限流沿用外层已认证 web router，上传准入在解析 multipart 前。浏览器 queue 行 `{ namespace, uploadId, captureId, blob, filename, hints, state, lastError }`，`state` 为 `pending | uploading | failed`，ack 后删除 blob。namespace 是服务端稳定随机草稿标识，不是学生 ID 或登录令牌。

- [ ] **Step 1: 建立失败测试。** 390×844 手机视口连续添加 3 图不被识别等待阻塞；相册多选；不加标签；响应丢失后刷新/关页重开；IndexedDB 拒写；会话过期、切号、另一标签页在途请求；旧 HEIC 与无 JS 单张上传。

```ts
// test('finishes capture without visiting a per-photo question picker')
await expect(page.getByText('勾出做错的题', { exact: true })).toHaveCount(0);
await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toBeVisible();
// test('never calls a browser draft saved before server acknowledgement')
await expect(page.getByText('照片已保存，可以先离开', { exact: true })).toHaveCount(0);
// test('does not resume student A drafts under student B')
expect(studentBUploadedAssetIds).toEqual([]);
expect(studentBVisibleDrafts).toEqual([]);
```

- [ ] **Step 2: 运行红灯。** `npx vitest run tests/integration/materialRoutes.test.ts`、`npx playwright test tests/e2e/materialCapture.spec.ts`；预期路由不存在/拍照旅程失败。
- [ ] **Step 3: 实现路由和 SSR 结果页。** `/s/capture` 使用新捕获入口；新增 POST `/s/materials/captures`、POST `/s/materials/uploads`、GET `/s/materials`、GET `/s/materials/questions/:id`、POST `/s/materials/assets/:id/hints`、POST `/s/materials/assets/:id/document`、POST `/s/materials/links`、POST `/s/materials/links/:id/undo`、POST `/s/materials/jobs/:id/retry`；原图 GET `/s/materials/assets/:id/image` 校验 owner。GET 仅查询，POST 校验 CSRF/输入/引用权限。标签可清除、批量选择素材后修改；同图多角色。结果按题显示找到/缺少/待确定，不逐图返回列表；关联候选含原图和区分依据。
- [ ] **Step 4: 实现浏览器队列。** 复用 `photoUpload.ts` JPEG/HEIC 转换，转换与网络各最多 1 张在途，不同时解码所有大图；支持继续采集。保持准备 30s、上传 120s 超时及同 uploadId 重试；重开将 uploading 复原 pending。服务端 429 尊重 Retry-After；400/413 不无限重试。quota 失败显式提示并降级单张直传；用户可重试/删除失败项。后台/关闭状态不承诺上传继续。
- [ ] **Step 5: 实现身份切换和提示。** 每次 resume/upload 前核验服务端 draftNamespace；请求携带预期 namespace，服务器在写入前拒绝不一致，避免已排队 POST 在切号后用新 cookie 入库。退出时有待传项提供“继续上传 / 删除待传后退出”，跨标签页通知 abort 并清理该 namespace；会话到期留原 namespace 暂停，重新认证同学生才恢复。升级同意文案及静态资源版本，SW 不缓存照片/草稿/API。固定提示：“题目、答题卡、作答或答案都可以拍，顺序不限，之后还能补。”
- [ ] **Step 6: 验证并提交。** Step 2 PASS；`npx playwright test tests/e2e/photoUpload.spec.ts tests/e2e/studentHost.spec.ts` PASS。
  `git add src/web/uploadQueue.ts src/web/materialsRouter.ts src/web/views/materials.tsx src/web/router.ts src/web/photoUpload.ts src/web/assets.ts src/web/session.ts src/web/views/today.tsx src/studentHost/router.ts src/studentHost/worker.ts tests/integration/materialRoutes.test.ts tests/e2e/materialCapture.spec.ts tests/e2e/studentHostServer.ts`
  `git commit -m "feat(web): capture materials continuously with recoverable drafts"`

### Task 6: 手工、导入与 AI 答案并存

**Files:** Create `src/materials/answers.ts`; Modify `src/materials/provider.ts`, `src/materials/queries.ts`, `src/materials/links.ts`, `src/web/materialsRouter.ts`, `src/web/views/materials.tsx`; Test `tests/integration/materialAnswers.test.ts`.

**Interfaces:** `saveManualAnswer(store: MaterialStore, input: { questionId: string; subpart: string | null; text: string; claimedSource: string | null; expectedRevision: number }): ReferenceAnswer`；`importAnswerText(store: MaterialStore, documentId: string, text: string): { saved: ReferenceAnswer[]; pending: { number: string; text: string }[] }`；`requestAnswers(store: MaterialStore, jobs: MaterialJobs, input: BatchRequest): BatchAction`；`selectAnswerBasis(store: MaterialStore, questionId: string, answerIds: string[], expectedRevision: number): void`；使用 Task 3 `MaterialProvider.answer`。

- [ ] **Step 1: 建立失败测试。** 同题已有 AI 答案后补老师答案、手工声明“老师提供”、批量粘贴同号无法唯一定位、冲突、生成时改题干、刷新/重复请求。

```ts
// it('retains imported manual and AI answers with their real provenance')
expect(answerSources).toEqual(expect.arrayContaining(['imported', 'manual', 'ai']));
expect(manual.source).toBe('manual');
expect(originalStudentWork).toEqual(workBeforeAnswer);
// it('does not silently choose conflicting answers or publish stale AI output')
expect(conflictingBundle.answerConflict).toBe(true);
expect(oldGeneration.stale).toBe(true);
expect(answerCallsAfterReload).toBe(answerCallsBeforeReload);
```

- [ ] **Step 2: 运行红灯。** `npx vitest run tests/integration/materialAnswers.test.ts`；预期答案服务/来源断言失败。
- [ ] **Step 3: 实现答案版本和选择规则。** 导入答案引用 source fragment；手工答案文字 1–40000 字、说明最多 200 字，修改追加版本。来源相同且文字仅空白差异可折叠，不能凭不可靠语义相似度消除冲突。跨来源不一致则题级提示选择依据；保留所有版本，不自动重批。唯一无冲突的提供答案默认优先；无提供答案时可明确请求 AI。批量粘贴先按完整题号/小问匹配选中文档，不唯一的保留 pending 并显示原文。
- [ ] **Step 4: 实现按需生成入口。** POST `/s/materials/answers/manual`、`/answers/import`、`/answers/generate`、`/answers/basis`；单题和文档批次共用 `BatchRequest`。完整且关联确定的题入队，其他返回 skipped 原因；缺题干不可生成。job 以请求键及题干 basis 幂等，保留模型/时间/依据；新答案改变已采用依据时使依赖它的批改过期。页面明确分“提供的参考答案”“AI 参考答案”，不把手工声明升级为核验来源。
- [ ] **Step 5: 验证并提交。** Step 2 PASS，Task 4 的改绑/撤销测试 PASS。
  `git add src/materials/answers.ts src/materials/provider.ts src/materials/queries.ts src/materials/links.ts src/web/materialsRouter.ts src/web/views/materials.tsx tests/integration/materialAnswers.test.ts`
  `git commit -m "feat(materials): retain answer provenance and explicit AI generation"`

### Task 7: 学生发起的按需批改

**Files:** Create `src/materials/grading.ts`; Modify `src/materials/provider.ts`, `src/materials/queries.ts`, `src/web/materialsRouter.ts`, `src/web/views/materials.tsx`; Test `tests/integration/materialGrading.test.ts`.

**Interfaces:** `requestGrades(store: MaterialStore, jobs: MaterialJobs, input: BatchRequest & { attemptByQuestion?: Record<string, string> }): BatchAction`；`gradeQuestion(store: MaterialStore, provider: MaterialProvider, jobId: string, signal: AbortSignal): Promise<void>`。每个任务冻结选定 attempt 和 answerIds；多次作答未指定且无唯一候选时 skipped，不默取最新一次。

- [ ] **Step 1: 建立失败测试。** 一份材料混合已批改、未批改、部分批改，包含缺图、无作答、答案冲突、无评分标准题；批改中改关联，模型引用不存在的片段，重复请求。

```ts
// it('grades only eligible requested attempts and never updates mastery')
expect(action.jobs).toHaveLength(2);
expect(action.skipped).toHaveLength(3);
expect(masteryAfter).toEqual(masteryBefore);
expect(reflectionsAfter).toEqual(reflectionsBefore);
// it('preserves teacher marks and cannot invent exact points')
expect(bundle.teacherMarks).toEqual(teacherMarksBefore);
expect(gradeWithoutRubric.score).toBeNull();
expect(gradeFromOldBasis.stale).toBe(true);
```

- [ ] **Step 2: 运行红灯。** `npx vitest run tests/integration/materialGrading.test.ts`；预期批改服务不存在/资格筛选失败。
- [ ] **Step 3: 实现资格检查与模型验证。** 需完整题干、必要图形、作答及明确关联；failed/unchecked/stale 不进入自动批改，low 片段不能支持确定结论，返回待补充/无法确定。无答案时本次明确批改请求可先生成 AI 参考答案，分别保存并显示；两阶段各有预算，不由页面刷新续开新预算。验证 finding 引用选定 attempt 的真实片段，score 必须引用本题实际评分标准且数值合法；无依据则 score=null。结果保留 correct/partial/incorrect/uncertain，不转换为教师结论。
- [ ] **Step 4: 接入按钮与任务回显。** POST `/s/materials/grades` 支持题级/文档级；显示哪些题在批改、哪些缺什么、哪些依据冲突。上传/标签/手工答案不调用此接口。结果写入前 CAS 比较 basis；旧响应标 stale，刷新仅读取，不回写学生原作、不提交反思、不改掌握状态。
- [ ] **Step 5: 验证并提交。** Step 2 PASS，并验证 Task 6 答案子任务重试不重复收费的计数测试。
  `git add src/materials/grading.ts src/materials/provider.ts src/materials/queries.ts src/web/materialsRouter.ts src/web/views/materials.tsx tests/integration/materialGrading.test.ts`
  `git commit -m "feat(materials): grade requested attempts with versioned evidence"`

### Task 8: 新旧来源接入同一网页错题本与复盘

**Files:** Create `src/learning/contracts.ts`, `src/learning/sources.ts`, `src/learning/queries.ts`, `src/materials/learning.ts`; Modify `src/ai/provider.ts`, `src/ai/evidence.ts`, `src/ai/stagedProvider.ts`, `src/ai/mockProvider.ts`, `src/v2/weekService.ts`, `src/v2/practiceService.ts`, `src/v2/reflectionService.ts`, `src/v2/correctionService.ts`, `src/v2/returnService.ts`, `src/v2/router.ts`, `src/web/router.ts`, `src/web/materialsRouter.ts`, `src/web/state.ts`, `src/web/weekPlan.ts`, `src/web/views/items.tsx`, `src/web/views/practice.tsx`; Test `tests/integration/materialLearning.test.ts`, `tests/integration/materialLegacyApi.test.ts`.

**Interfaces:** `LearningSource = { kind: 'legacy'; jobId: string } | { kind: 'material'; questionId: string }`；`LearningScope = 'legacy' | 'all'`；`LearningContext = Pick<Evidence, 'questionNumber' | 'questionText' | 'subject' | 'chapter' | 'knowledgeTags' | 'questionType' | 'requiresDiagram' | 'observations' | 'uncertainties'>`（此处 Evidence 为旧类型）。`LearningCard = Omit<V2WeekItem, 'jobId'> & { source: LearningSource }`。`getLearningSource(itemId: string): LearningSource | null`；`getLearningContext(itemId: string): { revision: number; context: LearningContext } | null`；`setQuestionIncluded(store: MaterialStore, questionId: string, included: boolean, expectedRevision: number): { itemId: string | null; revision: number }`。在 `src/ai/evidence.ts` 新增 `validateLearningContext(input: unknown): LearningContext`，只检查文本上下文，不代替原图证据校验。

查询返回类型在 `src/learning/contracts.ts` 定义：`LearningWeek = Omit<V2WeekResponse, 'items' | 'backlog'> & { items: LearningCard[]; backlog: LearningCard[] }`；`LearningPracticeCard = Omit<PracticeCard, 'jobId'> & { source: LearningSource }`；`LearningRecommendation = Omit<RecommendResponse, 'recommended' | 'others'> & { recommended: LearningPracticeCard[]; others: LearningPracticeCard[] }`；`LearningPracticeDetail = Omit<PracticeDetail, 'items'> & { items: (LearningPracticeCard & { position: number })[] }`；`LearningCreateResult = Exclude<CreatePracticeResult, { ok: true }> | { ok: true; detail: LearningPracticeDetail }`。以上旧类型分别来自 `weekService.ts`、`practiceService.ts`，只使用 type import，避免运行时循环依赖。

- [ ] **Step 1: 建立失败测试。** 旧题和新题同时可见/推荐、题干未补不进练习、重复关联只一份错题、再次作答不再建同一题、取消/撤销、反思和 OCR 修正、旧 API response schema 和历史 packet。

```ts
// it('projects one learning item and keeps incomplete questions out of practice')
expect(itemIdsForQuestion).toHaveLength(1);
expect(recommendationIds).not.toContain(incompleteQuestionItemId);
expect(webItemSources).toEqual(expect.arrayContaining(['legacy', 'material']));
// it('preserves legacy API shapes and student-owned reflection')
expect(legacyWeekBody).toEqual(expectedLegacyWeekBody);
expect(autoSubmittedReflections).toBe(0);
expect(originalImageHashesAfterCorrection).toEqual(originalImageHashesBefore);
```

- [ ] **Step 2: 运行红灯。** `npx vitest run tests/integration/materialLearning.test.ts tests/integration/materialLegacyApi.test.ts`；预期适配器不存在或新题未进入网页。
- [ ] **Step 3: 实现唯一映射及来源读取。** `material_item_link` 唯一关联 question 和 error_item；缺题干仍留材料层，学生收录意愿先保存，补全后才投影。老师明确错题、有效 AI incorrect/partial 可按已保存收录偏好进入；AI 来源仍可见，用户排除优先，uncertain 不自动收错题。既有 mobile_item_link 优先识别为 legacy，迁移不得让同一题在列表出现两次。source_asset 只是学习记录锚点，不代表所有 crop 来自它；item_index 在事务中分配，遵守既有 `(asset_id,item_index)` 唯一约束。POST `/s/materials/questions/:id/inclusion` 接收 included/expectedRevision 调用 `setQuestionIncluded`；取消只影响后续推荐，保留已有 packet/历史作答引用，撤销可恢复收录意愿。
- [ ] **Step 4: 抽出共享查询内核、保留旧包装。** `src/learning/queries.ts` 实现 `getLearningWeek(mobileDataDir: string): LearningWeek`、`recommendLearningPractice(mobileDataDir: string): LearningRecommendation`、`createLearningPractice(body: unknown): LearningCreateResult`、`getLearningPractice(id: string): LearningPracticeDetail | null`、`listLearningPractices(): PracticeSummary[]`。现有 week/practice 导出函数为 legacy 包装、保持签名及 jobId:string；内核按 scope 选择来源，禁止伪造 jobId。网页改用 all 包装。旧 `/v2` 对仅新来源/混合 packet 返回 404，并且列表不暴露它们；其他旧 packets 行为保持。所有反思、修正、回传前的来源/packet 校验改为内核共用，旧路由显式 legacy gate；修正服务内核返回 LearningCard，旧路由将 legacy card 序列化回原 jobId 字段，不在旧 response 增加 source。
- [ ] **Step 5: 适配文本服务和学习状态。** followup/correction 及 `CoachProvider.coachForPrint` 改接收最小 `LearningContext`，旧 Evidence 可结构兼容；真实/mock provider 使用 `validateLearningContext`，文本修正验证器使用相同上下文。原来的完整 Evidence 验证器保留，新 observation 使用稳定片段 ID、regionId=null，不伪造坐标。材料 OCR 修正写新转写版本，保留原图和既有原作防篡改校验，不能把错误答案改成正确答案；变动按 basis 失效。练习候选沿用现有延迟重做/推荐规则；收录后允许直接结束，“安排本周练习”独立。替换今天页对“必须逐照片选题”的新材料指引。
- [ ] **Step 6: 验证并提交。** Step 2 PASS；`npx vitest run tests/integration/v2Practice.test.ts tests/integration/v2Correct.test.ts tests/integration/v2Journey.test.ts` 和 typecheck PASS。
  `git add src/learning src/materials/learning.ts src/ai/provider.ts src/ai/evidence.ts src/ai/stagedProvider.ts src/ai/mockProvider.ts src/v2/weekService.ts src/v2/practiceService.ts src/v2/reflectionService.ts src/v2/correctionService.ts src/v2/returnService.ts src/v2/router.ts src/web/router.ts src/web/materialsRouter.ts src/web/state.ts src/web/weekPlan.ts src/web/views/items.tsx src/web/views/practice.tsx tests/integration/materialLearning.test.ts tests/integration/materialLegacyApi.test.ts`
  `git commit -m "feat(learning): integrate material questions without changing legacy API shapes"`

### Task 9: 多来源媒体与不可变打印快照

**Files:** Create `src/materials/media.ts`; Modify `src/learning/sources.ts`, `src/v2/printService.ts`, `src/web/router.ts`, `src/web/views/items.tsx`, `src/web/views/practice.tsx`; Test `tests/integration/materialPrint.test.ts`.

**Interfaces:** `readFragmentImage(store: MaterialStore, fragmentId: string, revision: number): Promise<Buffer>`；`getLearningPrintInput(itemId: string): { basisKey: string; context: LearningContext; questionRegions: SourceRegion[]; diagramRegions: SourceRegion[]; redactRegions: SourceRegion[]; answers: ReferenceAnswer[]; badge: 'ok' | 'low' } | null` 位于 sources。legacy 分支从真实单图 Evidence 适配，新分支从当前 QuestionBundle 获取；原始 source hash 和 crop 检查必须匹配。

- [ ] **Step 1: 建立失败测试。** 两张来源不同但坐标相同的题干/作答、跨页题干、答案紧贴题干、缺必要图、答案冲突、打印后改绑及补答案、打印生成中修改 basis。

```ts
// it('renders each crop from its own source without leaking answers')
expect(questionPageContainsSyntheticAnswerMarker).toBe(false);
expect(renderedQuestionParts).toEqual(['page-1-stem', 'page-2-stem']);
// it('keeps an existing print immutable when later answers conflict')
expect(frozenSnapshotBytesAfter).toEqual(frozenSnapshotBytesBefore);
expect(frozenAnswerBasisAfter).toEqual(frozenAnswerBasisBefore);
expect(currentQuestion.answerConflict).toBe(true);
```

- [ ] **Step 2: 运行红灯。** `npx vitest run tests/integration/materialPrint.test.ts`；预期多源裁图失败/快照不一致。
- [ ] **Step 3: 实现原图与裁图访问。** 所有 region 带 asset/hash/revision，用各自原图裁切，绝不把不同照片坐标 union 后拿第一张裁。详情显示按来源/页序的图组，保持查看原图。新材料必要图缺失/未核验/关联歧义返回待补，不能伪置 verified。低置信但具备可用完整原图的题走既有警示/遮白规则；遮白范围同源计算。legacy 分支沿用已有打印资格，不给历史低置信题额外加人工确认门槛。
- [ ] **Step 4: 实现打印输入适配和冻结。** 沿用快照协议：可靠题干排文字；原图模式按页序拼合已裁切且遮白的题干区为 cropMedia，diagramMedia 逐图保留，答案仅在答案页。采用 sharp 顺序处理并控制输出像素/内存，过大时明确失败可重试，不能静默截断。快照保存本次来源 manifest、basis 及所用答案；导入/手工映射旧 `source:'paper'` 并标具体来源，AI 映射 `source:'ai'`。冲突未解决时不自行选择答案/调用 coach 覆盖，可保留“参考答案待确定”。生成中 basis 改变拒绝发布混合版本；ready 快照永不回写，后续新包使用新版本。
- [ ] **Step 5: 验证并提交。** Step 2 PASS，`npx vitest run tests/integration/v2Print.test.ts tests/integration/v2Return.test.ts` 和 `npm run typecheck` PASS，确认旧快照无迁移重渲染。
  `git add src/materials/media.ts src/learning/sources.ts src/v2/printService.ts src/web/router.ts src/web/views/items.tsx src/web/views/practice.tsx tests/integration/materialPrint.test.ts`
  `git commit -m "feat(print): render source-aware questions and freeze answer provenance"`

### Task 10: 完整旅程、隔离与点击验收

**Files:** Create `tests/e2e/materialJourney.spec.ts`, `tests/integration/materialIsolation.test.ts`, `docs/quality/2026-10-20-material-linking.md`; Modify `tests/e2e/studentHostServer.ts`, `docs/CODEX_CLOUD_HANDOFF.md`。

**Interfaces:** 使用 Task 5 真实邀请网关 fixture 与 Task 3 确定性 provider；不新建绕过认证的演示入口。fixture 加可控提取/答案/批改延迟及失败，仅测试环境启用。

- [ ] **Step 1: 建立完整旅程失败测试。** 一条旅程从答题卡→乱序题干→跨日答案→解决一处冲突→收录→练习→打印→延迟回传；另一条从无标签同页开始；第三条两个学生同题号/标签/文件与切号草稿。记录每种身份下所有新 URL 的读写拒绝，CSRF、原图、关联目标、答案、批改和打印都覆盖。

```ts
// test('collects freely and asks once for a whole-sheet ambiguity')
expect(requiredLabelClicks).toBe(0);
expect(perQuestionConfirmationClicks).toBe(0);
expect(documentChoiceSubmissions).toBe(1);
expect(postCaptureNavigationToStatus).toBeLessThanOrEqual(1);
// it('rejects every cross-student material reference')
expect(crossStudentReadStatuses.every(s => s === 404)).toBe(true);
expect(studentAStateAfterBAttempts).toEqual(studentAStateBefore);
```

- [ ] **Step 2: 运行红灯并定位剩余集成缺口。** `npx vitest run tests/integration/materialIsolation.test.ts`、`npx playwright test tests/e2e/materialJourney.spec.ts tests/e2e/materialCapture.spec.ts`；若已通过，保存证据，不为制造红灯修改正确实现。
- [ ] **Step 3: 修复被验收暴露的实际缺口。** 修复进入所属模块及对应定向测试。人工检查 390×844 与桌面视口的按钮、缺材料状态、原图候选、长题号/长标签、失败重试及来源标识；使用合成数据截图。点击统计区分站内操作与系统拍照/相册动作，记录主动耗时、页面往返、滚动、错关联与恢复结果，不把 mock 旅程等同真实准确率。
- [ ] **Step 4: 完整门禁与文档。** `SEL_AI_MODE=mock npm run verify` 全部通过；`git diff --check` 通过。质量记录写清运行环境/命令/结果、合成测试范围、尚需真机与真实识别试用的项目；handoff 更新当前能力，不写成已上线。按执行技能完成最终独立审查，处理实际发现后只重跑受影响检查；新改动涉及广泛入口再完整门禁。
- [ ] **Step 5: 提交验收记录。** `git add tests/e2e/materialJourney.spec.ts tests/integration/materialIsolation.test.ts tests/e2e/studentHostServer.ts docs/quality/2026-10-20-material-linking.md docs/CODEX_CLOUD_HANDOFF.md`，另精确加入 Step 3 实际修复文件，检查 staged diff 后 `git commit -m "test(materials): verify capture linking and learning journeys"`。

## 执行顺序与覆盖自审

按 Task 1→10 执行；Task 8 共享接口变化较多，单独 gate 后再进打印。所有任务属于同一完整交付，不在 Task 5 做完上传后宣布本轮完成。

| 设计验收行 | 实施及验证 |
| --- | --- |
| 无标签同页、可选标签且多角色 | 3、5、10 |
| 答题卡先到/跨日答案，题目先到/一次全导入 | 4、5、10 |
| 两卷同号、跨页小问、第二次作答 | 4 |
| 手工/导入/AI 答案，答案冲突 | 6、7、9 |
| 混合批改状态、按需批改、缺题干/作答/图形 | 3、6、7、8 |
| 改绑、撤销、并发、旧模型返回 | 4、6、7 |
| 超时/重传/刷新/重开/切号 | 2、5、10 |
| 历史题、打印快照、延迟重做、学生隔离 | 1、8、9、10 |

自审要求：实现前阅读本计划及设计稿；发现与现有代码签名不符时在所属任务修正并记录理由，不能用空题干 Evidence、假 jobId、跨来源坐标或默认合并同号题来绕过边界。
