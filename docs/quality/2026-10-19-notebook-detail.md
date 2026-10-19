# 单题学习详情验收 · 2026-10-19

范围：`codex/notebook-detail`，独立基于 `5d787e0`。本 PR 只处理单题阅读、已确认错因、真实练习历史和重做/续练；保留 SSR、学生空间隔离、1–8 题限制及现有延迟掌握判定，不加表、不加生产依赖。

## 页面和行为

- `src/web/views/itemDetail.tsx` 负责单题页面，`items.tsx` 保留原有 `ItemDetailPage` 导出与旧参数兼容；新增参数均可选。
- 整题照片使用 `scope=full&s=big`，不裁掉内容、不应用深色压暗；文字题干、原图入口在照片失败时仍可使用。原作答、订正、老师批注、参考答案使用默认折叠的原生 `details`。
- “我的错因与提醒”来自 `getV2Reflection(...).reflection` 的学生已确认记录。展示确认摘要、当时状态、错因、主观把握和页面时区下的记录日期（保留完整 UTC 时间戳作 `dateTime`）；不拿未确认 AI 建议代替学生反思。没有记录时中性说明，可直接重做。已有练习包时可选进入原有 `/why` 流程补充错因。
- 练习记录按实际作答日期、新建时间倒序；未作答显示“尚未作答”，未完成不误写成“做错了”。提示等级、当天/隔两天正确未计入延迟掌握、隔七天独立正确分别明确标注；缺少旧字段时不推断独立性或掌握。
- 主操作为“重做这题”或“继续练习”；识别修正、分类、移除收进“题目信息与管理”。没有新增自行标记掌握的入口。
- `POST /s/items/:id/practice` 先验证本学生空间内可见的 v2 题目；有未完成练习就复用原包；否则调用现有 `createPractice({itemIds:[id]})` 再调用 `requestPrint`，进入原在线/纸上练习。重复 POST 不建重复包。GET 详情不创建或准备练习包。
- 资格变化时返回 409，留在原题并说明查看记录/返回选其他题。可选 `returnTo` 仅接受 `/s/items` 与白名单查询和题目锚点；无效地址退回本题年级、学科及锚点。独立实现阶段使用本地白名单；与 PR1 集成后统一使用 `safeNotebookReturn` / `notebookUrl`，保留 `itemNotebookReturn` 薄封装以补上当前题目锚点，不再维护第二套验证。

## 元素与 Apple HIG 对照

这是网页对 HIG 的适配说明，不是 Apple 认证；44 CSS px 不宣称等同原生 pt。

| 元素 | HIG 依据 | 实现与证据 |
| --- | --- | --- |
| 整题照片、题干、错因和历史的阅读顺序 | [Layout](https://developer.apple.com/design/human-interface-guidelines/layout) / [Typography](https://developer.apple.com/design/human-interface-guidelines/typography) | 手机单列；桌面详情最大宽 720px；标题、内容区、次要元数据分层。照片完整比例。实际截图见下。 |
| 重做/续练与管理入口 | [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons) | 底部只有一个明确主操作；原生 POST 表单及链接；低频管理折叠。浏览器逐一测量所有可见链接、按钮、summary 均至少 44×44 CSS px。 |
| 原作答/答案按需展开 | [Disclosure controls](https://developer.apple.com/design/human-interface-guidelines/disclosure-controls) / Accessibility | 原生 `details/summary`，初始关闭；键盘、无脚本都可展开；SSR 测试核对默认不泄露展开状态。 |
| 学生确认错因、真实提示及日期标签 | [Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback) | 数据来自确认记录和 `review_attempt.completion/hint_level/performed_at`；状态不只用颜色；真实 HTTP 回传与浏览器旅程核对同日和提示标签。 |
| 返回错题本与资格过期恢复 | [Navigation and search](https://developer.apple.com/design/human-interface-guidelines/searching) | 返回链接保留年级/学科/章节/状态/搜索/题目锚点；拒绝外站或任意路径；过期 POST 原地保留上下文。浏览器往返历史及服务器测试覆盖。 |
| 明暗色、照片与可辨识文本 | [Color](https://developer.apple.com/design/human-interface-guidelines/color) / [Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode) | 复用现有语义色与系统字；照片保持白底原色；浅色、深色实际 Chromium 截图。复用的正文、次要文字、链接颜色对内容背景均达到 4.5:1（浅色正文/次要/链接为 17.01/5.95/5.42:1，深色为 15.63/7.71/7.08:1，按 WCAG 相对亮度计算）。 |
| 大字、焦点、底栏 | [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) | 320×740、200% 根字号无横向溢出；键盘焦点 `:focus-visible` 外框 ≥3px；最后管理链接滚入可见区时底边位于固定底栏上方；分别启用/关闭页面脚本。尊重现有 reduced-motion/reduced-transparency 规则，无新增动画。 |

## 实际合成截图

由 `tests/e2e/notebookDetail.spec.ts` 驱动真实配对、合成试卷上传、确认错因、重做、续练及结果提交后截取；不是静态设计稿，也不含真实学生资料。下面展示实际浏览器视口，避免整页截图将固定底栏画在长图中间而遮住正文。

| 场景 | 截图 |
| --- | --- |
| 390×844，浅色，题图与主操作 | [JS 浅色](assets/notebook-detail/detail-js-light.png) / [无脚本浅色](assets/notebook-detail/detail-nojs-light.png) |
| 学生已确认错因与当天独立正确 | [JS 错因](assets/notebook-detail/detail-js-reflection.png) / [无脚本错因](assets/notebook-detail/detail-nojs-reflection.png) |
| 深色，提示后正确与当天正确历史 | [JS 历史](assets/notebook-detail/detail-js-history-dark.png) / [无脚本历史](assets/notebook-detail/detail-nojs-history-dark.png) |
| 320×740，200% 字号，深色，展开管理与底栏 | [JS 大字](assets/notebook-detail/detail-js-320-large.png) / [无脚本大字](assets/notebook-detail/detail-nojs-320-large.png) |

重现截图：

```sh
NOTEBOOK_DETAIL_EVIDENCE=docs/quality/assets/notebook-detail npx playwright test tests/e2e/notebookDetail.spec.ts
```

## 验证记录

- RED：新增 6 个 SSR/单元测试及 4 个真实 HTTP 集成测试全部按预期失败，证明原实现缺少确认错因正文、真实历史标签和单题重做 POST。
- GREEN：针对新增行为 10/10 通过；整个 `webClient` 集成文件加单元文件 56/56 通过。
- Chromium 专项：2/2 通过，分别开启/关闭页面脚本；覆盖原生折叠、学生自己确认错因、单题创建、续练、同日正确、提示正确、明暗色、44px、键盘焦点、320px/200% 字号、最终控制可见及浏览器返回/前进。
- 一次浏览器夹具失败：两次上传完全相同的合成图片触发已有去重，没有产生新题；改为带可见随机合成编号的图片后两种脚本模式通过。未修改产品去重规则。
- `npm run verify` 首轮：typecheck/build 通过，73 个测试文件 **865 通过、5 跳过**；浏览器 **34 通过、2 失败、1 中断、6 跳过、9 未运行**，最终退出 130。两项失败均是原分类用例直接点击了现在位于折叠管理区的“修改分类”，其余断言未改。经根任务指示停止继续等待相同失败，不把此轮称为全绿。
- 分类用例改为先展开管理后，详情与分类两份浏览器文件 **4/4 通过（21.5s）**。详情场景进一步改用各自独立的临时合成学生服务器，最终两种脚本模式 **2/2 通过（21.2s）**，并重截上述实际截图；避免污染旧周闭环的共享夹具。最终版本包含照片失败后文字与原图链接可用的检查。
- 后续 RED→GREEN：增加“页面时区与进程日历跨午夜”回归，初次复现数据库已按 3 天计入延迟证据、详情却按 2 天标注未计入。修正详情生成日转换以遵循 `recordAttempt` 的现有进程日历；不改变领域日期判定。最终完整 `webClient` + `itemLearning` **57/57 通过（28.12s）**，typecheck/build、最终 typecheck 与 diffcheck 通过。
- 上述首轮全量命令启动于日期边界修正前；最终日期修正与测试入口更新后只运行受影响检查。根任务明确要求在后续 PR1+PR2 组合分支运行最终完整 `npm run verify`，本页不声称独立分支最终全量全绿。

验证对应的提交：`09d8989` 保存单题功能实现（其生产页面代码对应首轮全量命令；后续浏览器夹具与导航适配另外按上述专项检查验证）；下一条日历修正提交仅改变详情日期转换及新增回归，最终 57 项专项、类型检查和构建结果适用于此修正后的代码。

## 独立评审后的确认日期修正

独立评审指出确认事件的日期仍直接截取 UTC 日期。新增两组 SSR 与真实 HTTP 回归：`2026-10-18T16:30:00.000Z` 在 `Asia/Shanghai` 显示 `2026-10-19`，`2026-10-19T00:30:00.000Z` 在 `America/Los_Angeles` 显示 `2026-10-18`。4 项回归先全部失败；随后通过可选 `timeZone` 参数把路由的 `ctx.timeZone` 传入详情，使用现有 `localDayText` 格式化确认事件日期；旧调用方省略此参数时仍可渲染，默认采用进程时区。完整时间戳保留在 `time.dateTime`。

确认事件的显示日期遵循页面时区；练习延迟证据继续遵循 `recordAttempt` 的进程日历，已有 3 天边界回归保持通过。修正后完整 `webClient` + `itemLearning` **61/61 通过（16.85s）**，typecheck 与 diffcheck 通过；本次按根任务要求不重复全量或浏览器门禁，最终组合验证仍由根任务执行。已有截图中当前白天确认日期不受此午夜边界修正影响。

## 边界与未验证项

- 这是本地 Linux/Chromium 自动验收，不代表真实 iPhone/Safari、VoiceOver、真实学生题图、实际打印机或线上运行已验收。
- 独立评审通过后将 PR1 `e88f1b5` 合入 PR2；列表/详情共享冲突已保留双方功能。PR2 依赖 PR #34、两份 PR 仍目标 main，按 #34→PR2 顺序审查合并。组合验证结果见下方集成记录。
- 没有合并 main、推送、部署、读取生产数据或调用真实模型。


## PR1 与 PR2 集成记录

双方最初独立实现并评审；集成时保留 PR1 的默认阅读、联合筛选、精确选题与恢复校验，保留 PR2 的确认错因、真实历史、单题 POST 与续练。`items.tsx` 只保留新列表及详情 re-export，路由使用完整的新详情数据和现有服务；两条时区回归保持各自的 UI 事件日历/领域延迟日历职责。

详情返回统一复用 PR1 `safeNotebookReturn` / `notebookUrl`；新增继承属性状态 `toString` 的详情返回回归先失败，再消除重复白名单使其通过，仍为无锚点的合法返回补上本题锚点。真实 HTTP 过期 POST 用例现在先从联合筛选列表取得实际详情链接、再取得表单隐藏返回值并提交，证明 grade/subject/chapter/status/q/anchor 全链保留。已有 JS/无脚本浏览器的过滤列表→详情→返回用例增加了新详情主操作、确认错因空态和隐藏表单上下文断言。

组合实现提交 `e30e85a6a2c99f640bda3240b44af92f94f18266` 保留双方父提交；在提交并通知独立审查后，执行一次 `SEL_AI_MODE=mock npm run verify`，退出 **0**：typecheck/build 通过，Vitest **74 个文件、886 通过 / 5 项既有跳过**（53.74s），Playwright **48 通过 / 6 项既有跳过**（3.8 分钟）。日志：`/workspace/work/notebook-integration-verify.log`。整合专项先通过 helper/SSR/HTTP **77/77**（20.35s）与 JS/无脚本浏览器 **6/6**（39.6s）。该完整门禁覆盖先前中断的旧练习旅程，并消除了旧分类测试入口的失败；没有新增跳过或未解决的测试失败。

现有门禁全绿后，独立广审另发现一项尚未覆盖的 P3：短横屏下通用正文 caption 与错题本固定栏计数同时显示，而脚本只更新后者，可能出现旧/新计数矛盾。根任务随后安排一次专项修复，先更新 PR1 `944a516` 再合回 PR2；更早的全绿门禁不冒称运行在后续 CSS head，最终窄范围检查与 CI 状态见下方。此前 `8871dca` 证据提交仅更新文档，未修改已验证的实现。PR 安排已同步至[设计约束](../superpowers/specs/2026-10-19-notebook-reading-detail-design.md)。


## 最终横屏反馈窄范围修正

阅读分支 `944a5165de6fa8d97eb204ed7ecb50d25dc14ca8` 先修复唯一 P3，再合入详情分支。仅增加 `.notebook-selection-page .caption-flow{display:none}`，隐藏重复的正文服务端计数；错题本固定栏原有 polite/atomic 实时计数、按钮可访问描述及其他页面短视口行为不变。两种脚本模式的 844×390 回归先失败，再通过选择一题/原生章节 POST，核对唯一可见计数、当前按钮描述、唯一 live region、最终原图入口与主操作可达。既有竖屏、200% 字号、键盘与无脚本行为检查保留。

PR1 读库浏览器专项 **4/4 通过（33.9s）**，typecheck/diffcheck 通过。合入后组合详情+阅读浏览器专项 **6/6 通过（41.5s）**，typecheck/diffcheck 通过；不重复完整本地门禁。此前 `e30e85a` 完整门禁 **886 单元/集成通过、48 浏览器通过、5/6 既有跳过**是精确的更早快照证据；根任务将等待两份最终 PR head 的完整 GitHub CI，不能将旧门禁宣称为后续 CSS head 的全量结果。无新增真人读屏或真机验收声明。
