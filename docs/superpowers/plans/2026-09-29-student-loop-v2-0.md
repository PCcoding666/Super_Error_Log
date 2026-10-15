# v2.0 实施计划：学生闭环先跑通、线上先稳

日期：2026-09-29。依据：`docs/superpowers/specs/2026-09-29-student-loop-v2-design.md`（D1–D16）。执行：WorkBuddy（Kimi K3）写代码与测试；Claude 负责拆解、审查、iOS 编译与 UI 测试（WorkBuddy 沙箱跑不了 swift/xcodebuild）、装机前验收；Codex 可选做独立审查。用户负责：批准停机窗口、提供学生手机、回答 §13 未决问题。

## 目标（一句话）

学生能在手机上完成"拍照 → 留题 → 追问复盘 → 打印 → 下周回传 → 看结果"一整条链路，数据全在服务器，识别结果的每一处都能改且每次修改都被记录；线上服务在真实一周内不卡死。

## 全局约束（每个任务都适用）

- TDD：先写会失败的测试再改代码；合成图片、临时目录、合成 HTTP 模型服务器；测试不调真实模型、不读 `.env`、不读 `data/`。
- 领域规则不放松：AI 不替学生写反思；当天做对不算掌握；家长只见聚合；真实模式缺配置直接失败不降级。
- 不做视觉重做（D16），不做变式/新题（v2.1），不做答题卡关联（v2.1）。
- 不提交、不推送、不部署、不装机、不碰生产：这些动作只由 Claude 在审查后执行，或由用户批准。
- 保留工作区里 81 个旧目录删除（POC/、SuperErrorLog/ 等）原样，不 `git add .`。
- 每个任务结束写报告到 `.superpowers/sdd/2026-09-29-v2-0/task-N-report.md`：改了哪些文件、RED/GREEN 证据、没验证的事、遗留问题。

## 任务清单

### T0 基线收口（Claude，2026-09-29 完成）

- [x] 把 R1 可靠性返修、M1 状态引导、9/21–9/28 文档按主题提交到 `codex/ai-error-review-mvp`；旧目录删除与 `.ai/ .superpowers/ .workbuddy-ai/` 不入库。
- [x] 记录 M1 现状：swift test 77/77；模拟器 UI 21 项 1 失败（`testCropViewerNeverClaimsFullOriginal`）；M1 未验收，被 v2 设计取代，其中可复用的部分（TaskPresentation 聚合、页内原图、动态 Palette）在 T6 决定去留。

### T1 线上先稳：部署 R1 并演练回滚（WorkBuddy 执行，Claude 审查，用户批准窗口）

现状：线上 `current` = 0.1.1-manual-release；本地 R1 已通过 448 Vitest + 9 Playwright，发布包 `releases/super-error-log-0.1.1-r1-20260922.tar.gz`（SHA256 5ebdd357…7eab）。

**2026-09-29 已完成（Claude 执行，用户批准窗口）**，记录见 `docs/quality/2026-09-29-deploy-0.1.1-r1.md`。

- [x] 使用 R1 审查过的发布包（SHA256 核对一致），而非重新产包：WorkBuddy 正在同一工作区改 T2，重新产包会带入半成品。
- [x] 暂存到 `releases/0.1.1-r1`，切 `current`，只重启应用；Caddy 与原网站未动。
- [x] 验收：授权 health 200 六字段齐全；1 张合成图真实识别走到 completed；两次切换后 27 个任务状态指纹不变；journal 无异常。
- [x] 回滚演练：17:53:53 切回旧版、17:53:54 切回新版，均健康。
- [x] 部署记录已写。

### T2 单进程装配 + 共享数据库（WorkBuddy）

文件入口：`src/server.ts`、`src/mobile/server.ts`、`src/mobile/cloudAssembly.ts`、`src/app.ts`、`src/config.ts`、`src/db/connection.ts`、`deploy/systemd/super-error-log.service`、`deploy/README.md`。

**2026-09-29 已完成**（WorkBuddy 两轮，Claude 审查与独立复核）。报告：`.superpowers/sdd/2026-09-29-v2-0/task-2-report.md`。

- [x] 新入口 `src/main.ts`：一个进程提供 `/v1`（语义不变）与 `/v2`（同一设备令牌鉴权与限流）；回环模式同样可用。
- [x] **审查改判**：原计划"云端挂 Web 只读页"会让未成年人的题目与照片匿名暴露在公网，已删除。云端公网入口**不挂任何 Web 页面**（`/`、`/parent`、`/items`、`/trends` 一律 404）；Web 看板待有登录方案后在 v2.2 设计。
- [x] 启动时幂等建立唯一匿名学生档案；共用 `SEL_DATA_DIR/app.db`。
- [x] 部署单元 `ExecStart` 改为 `dist/main.js`；README 注明新增必填 `SEL_AI_MODE=bailian`、`SEL_DATA_DIR`。
- [x] 门禁（Claude 独立复核）：typecheck、build、Vitest 452/452、Playwright 9/9。

### T3 桥：识别任务 → 错题记录（WorkBuddy）

**2026-09-29 已完成**（WorkBuddy 两轮，Claude 审查与独立复核：typecheck、build、Vitest 465/465、Playwright 9/9）。简报与报告：`.superpowers/sdd/2026-09-29-v2-0/task-3-*.md`。与下列原始条目的差异：状态直接为 `ready_for_reflection`（D3）；只桥接 `registerV2Photo` 登记过的照片，`/v1` 历史任务永不进入学习记录；每个任务至多一份批次与原图记录；`needs_check` 与人工放行题徽标为 `low`；同哈希照片只收先登记者。遗留给 T4：桥接题 `verified=0` 会被现有 `submitReflection` 与 `reviewableItems` 拒绝，v2 来源的题需要单独的反思与选题规则。

文件入口：`src/mobile/service.ts`（任务终态钩子）、新文件 `src/bridge/recognitionToItems.ts`、`src/services/batchService.ts`/`evidenceService.ts`（复用）、`src/db/schema.ts`。

- [ ] 先写 RED：合成识别任务完成后，每道有证据的候选题变成一条 `error_item`（状态 `captured`）+ `evidence_record`（题干、区域、观察、知识点、裁图路径），带 `confidence_badge`（`ready` → 正常，`needs_check` → 低把握）；同一任务重复完成不重复建题；`selectionEvidence` 为 `unmarked/unclear` 的题**不建**错题，但保留在任务里供"同页其他题"补入。
- [ ] 源照片登记为 `source_asset`，裁图与图示文件登记到 Web 的资产存储，使现有 `getQuestionCrop` 可用。
- [ ] 坐标：移动端证据已是 0–1 矩形，直接复用；不改 `docs/CROP_COMPLETENESS.md` 的失效规则。
- [ ] `不是错题`：归档（`archived_not_worth_review`），不物理删除；`留下`：默认，不需要动作。
- [ ] 桥失败（存储错误）fail-closed，任务本身仍终态，错误进日志。

### T4 手机接口 `/v2`（WorkBuddy）

**进度（拆为 4a–4e）**：4a 错题卡片/删恢复/设置 ✅（1ee755d）；4b 推荐与建练习 ✅（91c49e1）；4c AI 追问与复盘 ✅（8c818ef）；4d 回传与回报、4e 修改识别结果与修改记录：进行中。各段简报与报告在 `.superpowers/sdd/2026-09-29-v2-0/`。T7（修正即测量报告）并入 4e。

文件入口：新目录 `src/v2/`（路由、DTO、鉴权中间件复用 `src/mobile/router.ts` 的设备令牌校验）、`src/services/*`（复用）、`src/db/schema.ts`（新增 `correction` 表）。

接口族（返回 JSON，全部设备令牌鉴权，300/分钟/设备限流沿用）：

| 接口 | 作用 | 背后复用 |
|---|---|---|
| `GET /v2/week` | 本周错题卡：裁图 URL、题号、学科、知识点、把握徽标、留/删状态、是否在本周练习 | `listItems` + evidence |
| `POST /v2/items/:id/discard` / `restore` | 不是错题 / 恢复 | `archiveItem` |
| `POST /v2/items/:id/correct` | 语音或键盘文字稿 → 模型生成修订包（前/后对照）；`revision` 乐观锁 + `clientRequestId` 幂等 | `saveEvidence` + 新提示词 |
| `POST /v2/items/:id/correct/accept` | 接受修订：证据 revision+1，旧检查失效并重跑；写 `correction` 记录（字段、前、后、方式） | `resolveEvidenceCrop`/`checkEvidenceCrops` |
| `GET /v2/practice/recommend` | 本周推荐 5–8 道 + 每题一句理由（把握低 / 概念错 / 同类复发） | `computeRecommendations` |
| `POST /v2/practice` | 按学生最终选择建包（上限 8），触发提示/答案生成与 PDF | `createPacket` + `analyzeEvidence('coach')` + `generatePacketPdf` |
| `GET /v2/practice/:id` / `/pdf` | 包详情与 PDF 下载 | `getPacket` |
| `POST /v2/items/:id/reflection/ask` | 返回**一个**追问，必须引用学生原作/订正；证据不足返回开放句 | `analyzeEvidence('diagnose')` 的 `clarificationQuestion` |
| `POST /v2/items/:id/reflection` | 学生回答（原话）+ 错因类别 + 把握四档 → 写 `error_diagnosis`；AI 归纳一句存在建议字段，不进反思 | `submitReflection` |
| `POST /v2/practice/:id/return` | 逐题：完成方式（独立/一级提示/二级提示/没做出来）、对错、做题日期、可选照片 | `recordAttempt`（按实际作答日期） |
| `GET /v2/practice/:id/summary` | 回报：几道暂时掌握、几道再做、把握与结果偏差、下一轮日期 | `attemptsForPacket` + mastery |
| `GET /v2/corrections/report` | 修正即测量：按字段的修改次数与修改率 | 新 |

- [ ] 每个接口先写 RED（合成数据、真实 HTTP、临时库），覆盖：鉴权失败 401；revision 冲突 409；重复 clientRequestId 幂等；反思来源为 ai 被拒；同日作答不产生掌握事件；未打印的包拒绝回传。
- [ ] `correction` 表字段：item_id、field（八项之一，见设计 §4.2）、before、after、method（voice/keyboard/rerecognize）、created_at。
- [ ] 追问提示词边界：不讲解、不评价、只问一句、引用观察记录原文；单元测试用合成响应断言"不含解题步骤"。

### T5 练习包 v2 版式与遮白裁图（WorkBuddy）

**2026-10-01 修订（D17）**：服务器不生成 PDF，改为生成并冻结"打印快照"，PDF 由手机原生排版。以 `.superpowers/sdd/2026-09-29-v2-0/task-5-brief.md` 为准；下列原始条目中"复用 printPacket/pdfService"与"PDF 程序检查"不再适用，版式内容要求不变，由 T6d 在手机端实现并检查。T6d 相应改为：升级 `ReviewPDF.swift` 为 v2 版式（不删除）。

文件入口：`src/services/printPacket.ts`、`src/services/pdfService.ts`、`src/ai/cropAudit.ts`（区域遮白复用）、`tests/integration/sliceB.test.ts`。

- [ ] 封面：周次、做题日（取学生设置里的默认做题时段，`POST /v2/practice` 可临时覆盖）、三条规则、题目清单（短 ID + 来源"原题"）。
- [ ] 学生设置（2026-09-29 用户决定，原卷两处都有）：`GET/PUT /v2/settings`，字段为默认做题时段、原卷通常所在（学校 / 家 / 不固定）；末页"对照原卷"的措辞随原卷所在变化。
- [ ] 题目页：短 ID、学科·知识点、题干**或遮白裁图**（低把握徽标的题一律用遮白裁图：把 student_work / correction / teacher_note 区域填白）、必要图示、一行"这题的关键一步是：______"、演算区、勾选框（独立 / 一级提示 / 二级提示 / 没做出来 ｜ 做题日期）。
- [ ] 末页可撕：按短 ID 的一级提示、二级提示、答案（有 `reference_answer` 观察记录印它并标"原卷参考答案"；否则印 coach 答案并标"AI 参考，未经老师核验"；两者都没有印"对照原卷"）。
- [ ] 程序检查：题目页无答案文本、无手写区域外露（遮白后像素抽样）、每题短 ID、末页存在、A4。
- [ ] 提示生成失败不阻塞打印：该题末页写"对照原卷"。

### T6 iPhone 改造（WorkBuddy 写，Claude 编译与跑 UI 测试）

分五个子任务，每个独立可验证。文件入口：`iOS/StudentApp/*`、`iOS/Tests/*`、`iOS/UITests/*`。

- [ ] **6a 数据层**：新增 `/v2` 客户端；删除本地 `StudyState` 里的反思、练习包、结果（保留照片与缓存）；本周页改为错题卡列表（留/不是错题）；徽标只显示不拦截。删除：逐题确认页、"我已逐项对照"开关、人工放行弹窗、示例题、分批同意（同意只在首次）。
- [ ] **6b 修正**：错题卡、复盘页、打印预览三处"不对，改一下"；按住说话（`SFSpeechRecognizer`，`requiresOnDeviceRecognition = true`，音频不出设备），松开显示文字稿可编辑，"生成修改" → 前后对照 → 接受/取消；键盘路径永远可用；权限文案入 Info.plist。
- [ ] **6c 追问与复盘**：只对本周练习的题；一屏 = 裁图 + AI 读出的原作/订正 + 一句追问 → 语音/键盘答一句 → 类别 + 归纳确认 → 把握四档。
- [ ] **6d 练习与打印**：推荐列表（可换、上限 8）→ 建包 → 服务器 PDF 预览 → 分享/打印。删除 `ReviewPDF.swift`。
- [ ] **6e 回传与回报**：逐题录入 + 日期 + 可选拍纸；回报屏三句话；随后回到本周。
- [ ] **6f 收口**：三个 Tab 合并为单一"本周"时间线（功能性布局，不做视觉重做）；UI 测试与合成服务器同步更新；swift test 全绿；模拟器 UI 全绿。
- M1 代码去留：`TaskPresentation` 聚合与 `InlineOriginalPhoto` 可复用；确认门禁相关代码删除。

**进度（2026-10-02）**：实际拆分与上面的初始设想不同，以架构约定 `.superpowers/sdd/2026-09-29-v2-0/ios-v2-architecture.md` 为准。已完成并提交：

- 6a 接口客户端与模型；6b `LoopStore` 与上传后登记；6c 单一主页、错题卡片、"不是错题/撤销"、"不对，改一下"（说一句或直接改字）、设置；6p 练习纸排版与 PDF 引擎（CoreGraphics/CoreText，Mac 上可渲染测试）及录结果/复盘表单规则；6e 打印、录结果、回报三个页面；6d 选题、追问复盘、练习卡全部入口；6g 整题大图、追问页语音；6h 下一份练习、更早的练习、回报"做对了，过几天再验证"一组；6i 按住说话需短按住、选题与练习详情行可读。
- 返修：6c-R1（面板状态、语音文字替换、权限时机、主页细节）、6c-R2（Swift 6 下系统回调继承主线程隔离导致闪退，模拟器复现并修复）。
- 服务器随之补充：T5-R2（没把握的题文字和截图都印、截图余量、题号规整、追问措辞）、T4f（`crop?scope=full` 整题大图）、T4g（回报 `pending` 组）、启动守卫（`/v2` 的 AI 配置缺失即拒绝启动）、提示词引号规则（线上模型 `qwen3.8-max` 在 JSON 模式下会被英文引号截断）。
- 验证方式：本机回环服务 + 真实模型 + 合成试卷，模拟器里用可选的界面走查（`LiveTourTests`）逐屏截图。已走通：相册导入 → 同意 → 上传 → 识别 → 错题出现；详情与改题；选题；追问与确认；打印预览；回报。
- 随后完成（同日）：6j（打印/录结果/复盘后练习卡跟上；按住说话的取消保险）、6f（删除 v1 三 Tab 界面与只被它们使用的方法，旧存档仍可解码；合成服务器支持 `/v2`；界面回归 `LoopJourneyTests` J1–J5 与 `CloudConnectionJourneyTests`；README 重写）。App 版本 0.2.0 (2)。
- 当前门禁：服务器 Vitest 562、Playwright 9；手机 `swift test` 317、模拟器界面回归 11 条；连真实服务的 `LiveTourTests`（可选）全流程通过。
- 仍未验证：按住说话的录音与识别回调（模拟器音频不可用，只能真机）；真实学生照片；真实打印。

### T7 修正即测量报告（WorkBuddy）

- [x] `GET /v2/corrections/report`（T4e 已交付，只含计数）。Web 只读页推迟：云端入口不挂任何网页，等有登录方案后再做。
- [ ] ~~Web 只读页 `/dashboard/corrections`~~：按字段的修改次数、出现次数、修改率、最近 3 个样例（前/后）；按周分组。
- [ ] 不含学生原话与照片。

### T8 装机与第一周真实运行（Claude + 用户）

- [ ] 全量门禁：typecheck、build、Vitest、Playwright、swift test、模拟器 UI。
- [ ] 部署 v2.0 到 ECS（含回滚演练）；健康检查与 journal 观察脚本。
  - 2026-10-02：`0.2.0-rc3` 已上线，回滚演练通过，记录见 `docs/quality/2026-10-02-deploy-0.2.0-rc3.md`。同日 App 0.2.0 (2) 已装到用户的 iPhone 16 Pro Max。
  - 发现：境外访问 `study.pccoding666.com` 在跨境线路上被按域名重置，用户身在新西兰的手机很可能连不上；国内访问预计正常但未从第三方网络实测。待用户决定是否换域名。
  - 交给学生前清空一次学习记录（家长自测时旧照片会自动登记进错题本）。
- [ ] 签名与安装到学生 iPhone 13 Pro Max；记录描述文件到期日，排第 6 天续签。
- [ ] 第一周观察表：周六总时长、每步时长、修正次数与字段、练习完成率、回传率、线上异常。

## 验收（v2.0，见设计 §12）

1. 周六 20 道错题从拍到打印不需要逐题确认。
2. 练习包每题有短 ID、关键一步、勾选框、做题日；末页有提示与答案；题目页无答案文本。
3. 下周回传后回报屏显示掌握变化；删 App 重装数据仍在。
4. 至少一道低把握题以遮白裁图上纸且无手写外露。
5. 语音追问与语音修正真机可用，键盘可用。
6. 线上真实一周无卡死任务；修正报告有数据。

## 执行顺序与并行

T1 独立，最先做（需用户批准窗口）。T2 → T3 → T4 → T5 串行（后端）。T6a 可与 T4 并行开始（先对着接口契约写客户端），6b–6e 依赖 T4/T5。T7 依赖 T4。T8 最后。

## 交接方式

每个任务开工前，Claude 给 WorkBuddy 一份任务简报（本文件对应小节 + 相关文件与现有测试清单）；WorkBuddy 完成后交报告；Claude 审查并跑 iOS 编译；发现问题回到同一任务修，不开新任务。
