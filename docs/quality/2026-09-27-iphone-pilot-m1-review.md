# iPhone 两周试用版 · M1 状态引导实现审查报告

日期：2026-09-27（28 日续有验证进展）。执行：kimi-k3（代码+测试）；Codex：独立审查 + 装机。计划：`docs/superpowers/plans/2026-09-27-iphone-pilot-m1.md`。**当前状态：编译、77 项单元/回归、模拟器构建、Debug bundle 核对、全套 UI 旅程初跑 20/21 均已完成；唯一失败项经截图/辅助层级证实为测试作用域问题，test-only 修复后定点 1/1 通过。M1 仍未验收：全真机环节未做（目标 iPhone13 Pro Max 当前不可用；可用的 iPhone16 不是授权目标）。**（早期「验证被沙箱阻断」为本机环境的**历史**记录，见下表。）

## 验证状态（最重要，先读）

| 验证项 | 状态 | 证据/原因 |
|---|---|---|
| `swift test`（单元/回归） | **✅ Codex 环境通过：77 测试 0 失败（round3）** | 日志 `/tmp/sel-native-review-20260928.DvJlko/swift-test-round3.log`。此前两批真实编译错误（`notConnectedToNetwork`→`notConnectedToInternet`；makeStore 协变 Self 默认参数；10 处缺 `try`）已由我方回修，round3 证实修复生效。 |
| `xcodebuild` 模拟器构建 | **✅ Codex 环境通过：build-for-testing exit 0，TEST BUILD SUCCEEDED** | 日志 `/tmp/sel-native-review-20260928.DvJlko/simulator-build.log`。（本机两次失败止于宏插件服务阶段，根因未定性；与 Codex 环境结果分开陈述。） |
| bundle 实物核对（私有照片排除） | **✅ 通过（仅 Debug 模拟器 bundle）** | 新鲜 Debug bundle 中 IMG_5516/5517/5518.jpg 三个文件与 `SyntheticExamples/` 合成图**逐字节一致**，与保留的私有 `SamplePhotos` 原件不同——声明式 exception set 排除实际生效。**Release bundle 未核对过。** |
| UI 旅程 | **初跑 20/21；唯一失败已证实为测试作用域问题，test-only 修复后定点 1/1 通过** | 全套初跑 20/21，唯一失败 `testCropViewerNeverClaimsFullOriginal`：截图+辅助层级**证实**其全局否定断言命中下层页 M1 内联原图（下层题目页 y=-202；裁图查看器为并列分支 ScrollView「crop-photo」→ Image「crop-photo」，无 Sheet 节点）——非裁图冒充原图。test-only 修复：否定断言限定裁图查看器作用域 + 恰好一个查看器 + 图片名如实标注；诊断附件保留；App 零改动。定点重跑 **1/1 通过**（fresh build-for-testing 通过）。**注意：这不是 21/21 的全新全量复跑。** 证据：`crop-scoped-build.log`、`crop-scoped.log`、`crop-scoped.xcresult`。`xcrun simctl not found` 诊断采集警告单列待查。 |
| `npm run verify`（后端） | **✅ 新鲜通过：448 Vitest + 9 Playwright** | 日志 `/tmp/sel-native-review-20260928.DvJlko/backend-verify.log`；本批未改后端。 |
| RED 证据 | 编译级 RED 已见（TaskPresentation 缺失时报 `has no member` 等）；行为级回归随 round3 全绿执行通过 | `iOS/Tests/TaskPresentationTests.swift`、`StudyStoreRegressionTests` 新增用例。 |

**结论（更新）：编译、77 项单元/回归、模拟器构建、Debug bundle 排除核对均已通过（Codex 环境）；后端 448+9 新鲜通过。UI 旅程：初跑 20/21；唯一失败经截图/辅助层级证实为全局查询作用域问题（非产品缺陷），test-only 修复后定点 1/1 通过——不是 21/21 全新全量复跑。M1 仍维持未验收（unaccepted）：真机环节未做（目标设备不可用，见下）。**

## 实现内容（范围仅 iOS/ + 计划/报告）

1. **照片卡聚合**（`Domain/TaskPresentation.swift`，纯逻辑入 StudentCore 可测）：七态精确规则（零候选完成≠已确认、定位中、全失败、全跳过、confirmed+failed、ready+processing 可先核对、未知状态 needsRefresh、仅全 confirmed 才绿）；真实计数常显；`nextActionableQuestion`（确认后继续下一道）；`RefreshIssue` 分类（offline/serviceUnavailable/unauthorized/unknown）。
2. **本周页**（`ThisWeekView.swift`）：有任务的照片整卡 NavigationLink 进同一任务（`recognition-job-<id>` 标识保留）；卡上语义 chip + 计数 + 下一步 + 失败分类文案；顶部「下一步」摘要条（有待办才可点橙色；未知态给真实刷新按钮 `refresh-stale-status`——修复了「说刷新却没 handler」）；未上传卡保持勾选语义与真实字节进度；busyTasks 不再误标上传（仅无 job 时才算上传中）。
3. **题目详情**（`RecognitionView.swift` 重写）：页内嵌入原图（复用 ZoomablePhoto，300pt 容器内双指缩放/平移），`InlineOriginalPhoto` 按 `SourceBinding`（任务+题目+revision+源图 URL）加载；**LoadSequencer 定序**：写 image 与上报门禁前校验当前代次，迟到旧图完成忽略，加载失败/重载清除可读与勾选；全屏查看器保留为可选「放大查看完整原图」（`compare-original`）。确认门禁 = 来源真实解码可读 + 必要图示本机可读 + 学生明确勾选，不再用模态框布尔；needs_check 仍只有人工放行；确认后双出口「继续下一道待处理 / 去复盘本题」（后者 sheet 呈现 ReflectionFlow，tab 绑定透传）。
4. **放行/确认过期保护**：弹窗呈现时捕获 `SourceBinding`，确认时重验身份一致并按捕获 revision 传给 `StudyStore.act(expectedRevision:)`——在真实改动边界拒绝旧结论，不发请求并提示重新对照。
5. **错误分类落地**：`RecognitionClientError.networkFailure(URLError)` 保留底层传输错误；`StudyStore.refreshJobs` 失败写 `lastIssueKind`（可选字段，旧档兼容）、成功清除；卡片显示「进度暂未更新」类文案而非误报失败。
6. **视觉**：Palette 全动态色（深浅双套）+ `Palette.card` 替换硬编码白底；移除强制浅色；`Palette.onTeal` 修复深色主按钮对比度；关键按钮 minHeight 44；卡片可访问标签。
7. **私有示例照片不进任何构建（第二修正版）**：脚本删除阶段已撤销（packaging 审查：依赖未展开变量、Release-only 保护不了 Debug 装机）；首轮 `membershipExceptions` 直接挂在 root group 上的写法也已被纠正——该属性属于 `PBXFileSystemSynchronizedBuildFileExceptionSet`（参照 XcodeGen `exceptionSet(target:membershipExceptions:)` → `syncedGroup.exceptions`）。现结构：新增 exception set 对象显式列出 `Resources/SamplePhotos/IMG_5516.jpg`、`IMG_5517.jpg`、`IMG_5518.jpg`（target = app），root group 以 `exceptions` 链接——三个私有 JPEG 在所有配置下都不进 app target，源文件保留未动。示例题「查看原图」改由 `Resources/SyntheticExamples/` 下三张程序生成的纯色合成 JPEG（480×640，无真实内容）承接，同名保证 bundle 查找不变；UI 旅程用合成图而非私人照片。**验证状态**：Debug 模拟器 bundle 已实物核对通过（三文件与合成图逐字节一致）；Release bundle 未核对。

## Codex 中期审查意见落实

- 迟到解码覆盖新题 → LoadSequencer 双重校验（写 image + 上报门禁前都查代次）；回归 `testLateCompletionFromEarlierLoadIsIgnored` / `testReloadInvalidatesEarlierCompletion`。
- 放行弹窗过期 → releaseContext 捕获 + 确认时重验 + act 边界 expectedRevision；回归 `testStaleExpectedRevisionBlocksConfirmBeforeAnyNetworkCall` / `testStaleExpectedRevisionBlocksManualRelease`。
- 「请下拉重试」无 handler → 改为真实只读刷新按钮。
- busyTasks 误标上传 → 仅无 job 阶段标上传。
- 深色主按钮对比度 → Palette.onTeal。

## Codex diff 审查第二轮（2026-09-28 02:46）落实

1. **确认闭包用不可变身份**：确认/放行的 Task 闭包改用勾选/呈现时捕获的 `comparedBinding`/`releaseContext`（含 taskID+questionID+revision+源图 URL），不再读可变的 `questionID` State。
2. **放行确认时重验**：除绑定一致外，还要求此刻原图仍可读（gate）且必要图示仍在本机（hasCachedDiagrams）；任一不符不发请求。
3. **加载开始/失败/消失全清**：`InlineSourceGate.begin` 改为无条件作废旧可读（含同绑定重载）；`InlineOriginalPhoto` 新增 `onStarted` 回调，加载开始即清可读+勾选+放行结论；`onResolved(false)` 与绑定消失（nil）路径同样清除两个确认上下文。回归：`testSameBindingReloadClearsReadability`。
4. **未知任务级状态**：`photoCard` 增加 `knownJobStatuses` 白名单，未来 job 状态落「状态需核对」而非「全部已确认」；interrupted/failed 任务保留每题计数。回归：`testUnknownJobStatusNeverReadsAllConfirmed`、`testInterruptedJobKeepsPerQuestionCounts`。
5. **夹具修正 + 失败确认回归**：`makeStore` 增加 `jobJSON` 参数，`testStaleExpectedRevisionBlocksManualRelease` 改为落库 needs_check 夹具（此前误用 ready 夹具，会因客户端前置校验而以错误原因通过）；新增 `testFailedConfirmPreservesQuestionState`——确认请求真实发出并 500 失败后，题目仍 ready、缓存任务不被改写、错误可见。
6. 后端基线：Codex 今日独立通过（448 Vitest + 9 Playwright，日志 `/tmp/sel-pilot-review-20260928.Oc6uQP/verify.log`）；本批未改后端。

## Codex 第三轮审查（2026-09-28 02:57）落实

1. **pbxproj 结构纠错**：`membershipExceptions` 不是 root group 的属性——改挂到新增的 `PBXFileSystemSynchronizedBuildFileExceptionSet`（target = app），root group 以 `exceptions` 链接；显式列出三个私有 JPEG 路径。参照 XcodeGen `PBXProjGenerator.swift` 的 `exceptionSet(target:membershipExceptions:)` 写法。
2. **闭包比较对象**：确认/放行闭包改为与动作发生时的 `self.binding` 现值比较（此前比较的是 body 渲染期冻结的捕获值）；确认闭包同时重验当前可读与图示在机。
3. **onDisappear 清除**：页面消失即作废勾选与放行结论（此前只覆盖加载开始/失败/绑定变化）。
4. 回归补充：`testActWithUnknownQuestionIDMakesNoNetworkCall`（act 身份守卫——题目 ID 不在任务中时不发请求）。绑定/onDisappear 属视图层行为；相关回归已随 Codex 环境 round3（77 测试 0 失败）执行通过。
5. 报告去断言：移除「沙箱症状而非代码错误」「Codex 环境可正常编译」等未证实表述。

（历史注记：本机沙箱曾阻断本地编译/测试，后由用户授权 Codex 重建 SwiftPM security 符号链接，Codex 环境完成全部编译与测试。）

## 改动文件清单

- 新增：`iOS/StudentApp/Domain/TaskPresentation.swift`、`iOS/Tests/TaskPresentationTests.swift`
- 修改：`iOS/StudentApp/{Theme,SuperErrorLogApp,ThisWeekView,RecognitionView,ReflectionView,ReviewPackView,StudyStore,RecognitionClient}.swift`、`iOS/StudentApp/Domain/Recognition.swift`、`iOS/Tests/StudyStoreRegressionTests.swift`、`iOS/UITests/LiveRecognitionJourneyTests.swift`（needs_check 两门测试适配页内原图门禁；新增整卡+双出口旅程）、`iOS/SuperErrorLog.xcodeproj/project.pbxproj`（声明式排除：`PBXFileSystemSynchronizedBuildFileExceptionSet` 列出三个私有 JPEG，root group 以 `exceptions` 链接；无脚本阶段、未动签名/构建设置）、`iOS/scripts/prepare-examples.sh`（仅注释说明该目录已无 bundle 效果）
- 新增资源：`iOS/StudentApp/Resources/SyntheticExamples/IMG_551{6,7,8}.jpg`（程序生成的纯色合成图，替代私有示例照片的 bundle 角色）
- 文档：计划与本报告。未动：后端 src/tests( TS)/deploy、其他未提交改动、手机、签名、网络设置；无提交/推送/部署。

## 仍阻碍真实学生使用的问题（如实列出，未处理）

1. **识别有误时没有修正出口**——题干识别错只能跳过/重拍；M2 语音/键盘修正仍是未来接口。
2. **纸质练习回传缺失**——纸上做完只能自述结果，没有拍照回传核对。
3. **签名持续性已确认约束**：用户无付费开发者账户，Personal Team 描述文件 7 天到期（Apple 官方口径）；临时计划为第 6/12 天本地重签、从不卸载，见下文「两周试用的签名约束」。本节从未操作签名。
4. 真机验收、VoiceOver 走查、深色/动态字号真实渲染均未做（真机不可用 + 本轮无设备操作授权）。
5. **查看器复用回归风险（待验证，非已修复）**：`SourcePhotoView`（全屏查看器）的 `.task(id: reference.url)` 内 detached 解码完成后直接赋 `image`，没有代次/取消校验——与已修的 `InlineOriginalPhoto` 同型风险；`ZoomablePhoto.updateUIView` 为空实现，复用同一 UIView 时是否残留旧图未经测试。这两处是**已识别的待验证风险**，本轮未改，须补回归后再验收。

## 验收状态

**M1 未验收（unaccepted）**。已通过：原生构建、swift test（77/0）、Debug bundle 实物核对、UI 旅程初跑 20/21 + 失败项 test-only 修复后定点 1/1、后端 448+9。**仍缺**：Release bundle 核对、真机环节。**设备现状（2026-09-28）**：目标 iPhone13 Pro Max 当前不可用；手边的 iPhone16 不是授权目标，本轮无签名/安装/提交/推送/部署。注：SwiftPM security 符号链接系用户授权下由官方 Swift 工具链重建，真实 security 目录（inode 1087028）未变，无数据删除、无安全弱化。

### 两周试用的签名约束（2026-09-28 确认）

- 用户无付费开发者账户；Apple 官方 compare-memberships 明确 Personal Team 描述文件 7 天到期。
- 计划：本地临时测试 + 到期前重签——约第 6 天与第 12 天各重签一次，**从不卸载 App**（保数据）；无 TestFlight；不作无人值守的两周可用性保证。
- 物理 iPhone13 当前不可用；真机环节待设备可用后单独安排。
