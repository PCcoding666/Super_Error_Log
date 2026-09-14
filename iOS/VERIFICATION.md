# 中文 iPhone 真实识别：阶段验收（2026-09-15）

## 一句话结论

**手机选照片、同意上传、收到真实 AI 结果，已经跑通；自动把照片整理成可信的错题和练习包，还没有通过验收。**

这次不再停在“手机点击后没有任务”：从系统照片库选择 IMG_5516，明确同意后生成了真实任务，应用显示6道候选题。原始照片与上传副本分开保存，上传副本与服务器收到的内容一致。照片仅在用户明确开始识别后上传，示例题没有混入真实结果。

## 十张照片，实际得到什么

本轮于03:19:48全部结束。十张通过同一个移动识别服务：1张来自手机界面，另外9张来自同一服务的批量接口。手机那张使用较早提示，其余9张使用更新后的阶段提示，不能把它们合并当作同版本模型准确率对比。

| 照片 | 本轮结果 | 可以直接整理进错题本吗？ |
| --- | --- | --- |
| IMG_5518 | 6道候选：5待核对、1流程失败 | 不可以 |
| IMG_5517 | 清单返回了内容，但可选的空警告字段被拒绝，未进入逐题提取 | 不可以 |
| IMG_5516（手机上传） | 6道候选：4待核对、2流程失败 | 不可以 |
| IMG_5507 | 7道候选，均待核对 | 不可以 |
| IMG_5515 | 清单坐标越界，未进入逐题提取 | 不可以 |
| IMG_5514 | 5道候选，均待核对 | 不可以 |
| IMG_5513 | 清单坐标越界，未进入逐题提取 | 不可以 |
| IMG_5512 | 5道候选，均待核对 | 不可以 |
| IMG_5511 | 6道候选，均待核对 | 不可以 |
| IMG_5510 | 8道候选，均待核对 | 不可以 |

合计：**43道候选，40道待核对，3道逐题流程失败，0道确认。** 另有3张照片停在整页清单检查，不能将它们的0条公开结果解释为模型完全没看见文字。原图主页面可见67道编号大题，但无编号例题、边缘残页和小问还需分别核对，候选数量不等于完整覆盖率，也不等于错题数量。

本轮254次模型请求均返回HTTP200；其中6次返回内容未通过结构检查。没有超时，不是“百炼连不上”。共记录输入1,030,233、输出83,333tokens，仅为接口用量，不是费用账单。两次单独的Max诊断和更早失败探针不混入此计数。

## 为什么没有判为通过

- **IMG_5518第13题**：印刷题干能读出，但裁图仍不完整；黑色作答中的根之和和`m=1`没有被忠实保留。
- **IMG_5516第14题**：学生写的`√16`被模型改成`√13`。只换Max、再加人工选择的原图特写，两次独立诊断仍有这个错误，均未接受。
- **IMG_5515顶部第1(4)小问**：清单里出现了大题1，不代表这一小问已提取正确；这张照片在清单坐标检查时已停止。
- **IMG_5511第13题**：用户确认的红色订正`+6x`仍被写成`+6y`；黑色原作的`−6y`是另一处，不能混淆。
- **IMG_5510第2(4)小问**：学生填的`3/2`被模型写成`3`。自动校对自己提到了`3/2`，却仍判断转写匹配。
- **局部正例**：IMG_5512第15题的三角形图，A/B/C/D/E/F及构造线完整、未见答案污染。但整题裁图的首行被截，所以不能算整题通过。

这些是对照完整原图和实际裁图得到的判断，不照搬模型的“检查通过”。本轮还发现校对模型常把本题自己的作答当作邻题污染，随后重新定位反而缩小裁框；已在后续提示中重申两者区别，但不能反过来修改本轮判分。

## 应用测试和真实题目验收分开看

| 范围 | 已有证据 | 限制 |
| --- | --- | --- |
| 后端及原有网页 | 03:15开始的完整验证：类型检查、构建、275项单元/集成、9项网页流程全部通过 | 模型响应为测试输入，不证明真实照片准确 |
| iPhone真实上传 | iPhone17Pro、iOS26.3.1模拟器：系统照片选择→明确上传→真实任务→6道候选显示 | 尚未走到真实题确认、复盘和PDF |
| 原生数据/界面 | 34项数据/客户端测试通过；03:48:21最终完整13项界面测试全部通过，0失败、0跳过 | 早先12通过、1失败及后续修复记录保留；这些是功能测试，不是模型准确率 |
| 合成长题PDF | 实际原生界面导出65小问，3页题干+1页图示/作答空间，最终版本逐页查看未见截断或订正泄漏 | 合成测试PDF，不是本轮真实照片PDF |
| 实体iPhone、实际相机、打印机 | 本轮未测试 | 不代表可以直接对外分发 |

后端完整验证使用非隐藏的独立副本，未复制密钥配置，复用本机已安装依赖，未重置原有数据库或测试数据。早先隐藏目录副本中的PDF下载失败，以及手机中间失败的测试记录，均保留。

## 后续修复与复测记录

已修复的代码包含：明确同意的照片不能被默默截去、损坏图示不能当可读证据、切后台后不重启轮询，以及复盘页展示图示/原作/订正、指定失败阶段显式恢复、同号题按页面位置区分、中文说明和裁图标签。最终完整界面回归通过；独立代码复核确认3项主要问题和2项次要问题均解决，没有新增严重或主要问题。唯一文档按钮旧名称也已对齐实际界面。这是代码质量结论，不是对真实识别质量的认可。

最终代码审查通过后，已仅恢复手机任务中格式失败的第10题。通过同一公开接口显式触发一次，随后在手机实际看到“正在识别”变成“有内容需核对”。本轮自动操作工具无法滚动到手机的重试按钮，所以这是**接口触发、手机接收的真实恢复**，不是手机按钮触发的真实验收；手机按钮的确认/取消行为另由完整界面测试覆盖。

恢复从保存的校对阶段继续，新增5次真实调用（3次校对、2次重新定位），全部HTTP200且结构合法，输入18,739、输出779tokens。没有重新做整页清单或题目转写，原照片、28条历史请求和其余5题的身份/内容/版本均未改变。失败的格式问题被恢复，但两次定位都返回原坐标，实际裁图仍截断题干，并混入下一题。最终自动检查正确拦住了“不完整”，但又错误地把“无邻题污染”判断为通过；对照实际裁图后未接受此结论。

第10题由流程失败变成待核对。变更后的本轮10图合计为**41道待核对、2道逐题流程失败、3张清单失败，仍0道可确认、0道已确认**。上面的43道候选基线及其40/3分类保持原记录，不被恢复结果覆盖。没有生成真实题目的复盘或PDF，也没有替学生填写真实反思。

本轮私有证据保存在忽略目录`data/mobile-pilot-20260914-krC7gn/`：手机上传记录`native-upload-manifest.json`、十图入口清单`ten-photo-run-v3.json`、完整基线`ten-photo-terminal-v3-1789413641445.json`、原图人工校对`source-review.md`、`q10-recovery-before/activated/after.json`及恢复回执/逐次请求记录。最终完整手机测试为`iOS/build/ui-final-root-complete-20260915-0343.xcresult`。照片、密钥、原始模型输出不随代码提交；没有写入网页正式错题库。

下一阶段需要改进的是**忠实保留笔迹和根据图像实际修正裁框**，不是继续堆界面或把待核对结果强行放行。本轮代码仅作为可复现的识别试验版，不能据此宣称真实错题整理已经交付。

## 以下是 2026-09-12 的历史原型记录

以下内容只说明当时的无 AI 原型和对应构建，不代表当前版本仍未接网；其旧设备矩阵也不替代本轮复测。

# Native prototype verification — 2026-09-12

## What this proves

The student-facing native prototype runs. It is not just a set of screenshots. A student can inspect a real original page, save their own reflection, resume after closing the app, deliberately choose a question, generate a clean A4 PDF, and record a self-reported paper attempt.

New photo import is real local storage. It remains explicitly **awaiting recognition service**, not an AI result. The imported IMG_5516 source bytes were retained unchanged (SHA-256 `ec56451d29ce97820aa5a004fe7ae11e1a4a935234efdc9d146c6f2efbeafbcd`).

## Verified matrix

| Environment | Evidence | Result |
|---|---|---|
| Xcode 26.6 / iOS 26.5 simulator SDK | Direct app + UI-test target build, arm64 and x86_64 | Built successfully; no global Xcode changes |
| macOS, Foundation domain tests | `swift test` | 11 tests passed |
| iPhone 17 Pro / iOS 26.3.1 | Original + resume, reflection → pack → redo, large text, real library import + relaunch | All 4 tests passed together in `build/ui-complete.xcresult` at 16:28 |
| iPhone 16 / iOS 18.6 | Original + resume, reflection → pack → redo, XXXL text | 3 tests passed in `build/ui-iphone16-verified.xcresult`; photo picker test excluded on this OS |
| Exported Q14 PDF | Native PDFKit text checks, Poppler rendering, visual inspection | 1 A4 page; full stem and both subquestions; working space; no √16/√13 answers |
| Real device camera / signing / actual printer | Not exercised | Still requires a physical-device pass |

The final combined iPhone 17 run is a new, separately retained run. Earlier failed runs have not been relabelled as successful.

## Issues found and addressed

- Explicit submission now writes the **currently displayed draft** atomically; it cannot silently submit an older autosaved version after a failed edit save. Failed drafts have an honest retry state.
- Local collection directories and atomic state replacements are excluded from backup. No network client or credentials are present.
- Debug test collections are isolated by UUID; the normal student collection is never reset by tests.
- A clipped last reflection option could be obscured by a floating footer. The footer is now a separate layout region. Small-screen tests explicitly scroll an option fully into view before tapping, and assert it was selected before testing restoration.
- Each new reflection prompt starts at the top, including after a scroll on large text.
- System Photos on iOS 26 exposes image frames but sometimes returns an invalid accessibility hit point. The test selects the observed image-frame centre and the system confirmation button, then verifies real persisted output. No application import result was mocked.
- The simulator's default SDK/runtime lookup fails because the matching 26.5 runtime is not installed. Direct target builds and an explicit test manifest use the already-installed runtimes, without changing `xcode-select`, runtime matching rules or system packages.
- A third-party PDF text parser misread Quartz CJK character maps. Native PDFKit extracts the original Chinese correctly; both native preview and Poppler rendering were visually checked. A failed parser check was not treated as a passing text check.

## Evidence and boundaries

Screenshots remain attached to each `.xcresult`; exported copies are in the corresponding ignored `build/*-attachments/` directories. A sample PDF and render are under `../data/iphone-prototype-20260912/`.

Prior failures remain under `build/ui-first`, `ui-second`, `ui-third`, `ui-iphone16`, `ui-photo-import`, and `ui-iphone17-final` result bundles. They include toolchain setup, layout/automation errors and their diagnostics; no history was deleted to produce a green report.

Independent read-only code review found no critical issue and two important issues (stale submission and backup exclusion); both were fixed and regression-tested. That review also inspected the three original printed stems.

Still not delivered: live AI recognition, full-page wrong-question coverage, diagram extraction, calibrated error attribution, grading, weekly scheduling, cloud sync, editable question correction, personal-photo removal UI, production signing or learning-efficacy validation. The native UI must not be taken as acceptance of those separate systems.
