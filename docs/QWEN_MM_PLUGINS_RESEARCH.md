# Qwen MM Plugins 对本项目的价值评估

日期：2026-09-20 · 调研对象：[Qwen-MM-Plugins](https://github.com/QwenLM/Qwen-MM-Plugins)（[Hub](https://qwenlm.github.io/qwen-mm-plugins-hub/)）· 视角：项目第一性原理

## 0. 它到底是什么

Qwen MM Plugins 是**给 Agent Harness（Claude Code / CodeBuddy / Codex / Qoder / Qwen Code / WorkBuddy 等）用的多模态能力包**，不是给产品后端用的 SDK。每个能力 = 一个 Skill（给 agent 看的操作手册）+ 一个可选的 MCP server（Python 工具进程）。Apache-2.0。

这一点决定了复用方式：**不能嵌进我们的 TypeScript 服务端管线**，但有三种真实价值——
1. **实现参考**：它们封装了 Qwen-VL/Omni 的官方最佳实践（prompt、坐标约定、EXIF 处理、payload 细节）；
2. **对照基准**：用官方工具跑我们的真实照片，定位"识别保真度 0 通过"是管线问题还是模型上限；
3. **开发/教研侧 agent 增强**：在 WorkBuddy/CodeBuddy 里装上，加速内容生产与评估。

## 1. 第一性原理映射

本项目的本质：**把纸质错题低成本编译成"未来会被独立重做"的纸质任务，用行为证据替代熟悉感。**

约束链：学校无屏幕（工作日纸质）→ AI 只做结构化/建议/调度/提示，绝不替代学生思考 → 一切识别结果必须过"证据核对"才能进入确认/打印。

当前 AI 管线的七个 stage：layout → transcribe → diagnose → coach → match → crop_inventory → crop_verify（DashScope 百炼 / OpenAI 兼容双 provider）。

当前最大卡点：**真实照片内容保真度验收至今 0 张通过**（非流程失败，是识别质量失败）。

## 2. 逐个插件判定

### A. `api`（Vision & audio APIs）— 高价值，直接对位 ⭐

MCP 工具：VL 系列 `vision_chat` / `ocr` / `grounding`；Omni 系列（音视频）；Qwen3-ASR；SAM3 分割。默认走 DashScope（我们已有 key 和配置路径）。

对位关系：

| 我们的 stage | 它的工具 | 能借鉴什么 |
|---|---|---|
| layout / crop_inventory（切题定位） | `grounding` | bounding box 的 prompt 写法、0–1000 归一化坐标约定、**EXIF 校正后再测量**的像素纪律 |
| transcribe（题干/笔迹转写） | `ocr` | 官方 OCR payload 与参数（`dry_run=true` 可直接查看发送内容） |
| diagnose（错因建议） | `vision_chat` | VL 自由问答的图像预算（max_pixels）与 token 成本权衡 |

**最有价值的用法——对照实验**：用它的 `ocr`/`grounding` 跑我们验收失败的同一批真实照片。
- 若官方工具结果显著更好 → 问题在我们管线（prompt / 预处理 / 分辨率预算），照抄修复；
- 若同样失败 → 是 Qwen-VL 对"手写+印刷混排试卷"的能力上限，应调整策略（更小裁剪单元、分页处理、人工兜底前置）。

这一步直接服务当前真机验收，成本是一个下午。

### B. `core` — 高价值参考 ⭐

本地媒体工具（read_image / crop / draw_bbox / media_info），默认无需 API key。与我们的 crop 管线同域。两个可直接核对的技术点：

1. **坐标系**：它统一用"EXIF 校正后的显示坐标 + 0–1000 归一化"。我们的 candidateBox 是 0–1 百分比（iOS 端 `box.x * 100` 显示）。坐标约定不一致是 crop 错位类 bug 的温床，值得对照检查全链路（服务器存储 → API 响应 → iOS 渲染 → PDF 裁剪）是否每一步都明确了"基于校正前还是校正后的像素"。
2. **EXIF 处理**：它在工具层强制应用 EXIF 方向。我们 J2 已做过 EXIF 转正，但值得核对 crop_verify 环节测量用的像素与展示用的像素是否同源。

### C. `edu-agent` — 战略相关，但必须克制 ⚠️

能力：题目图片 → 提取 → 分析 → 中文口播稿 → Qwen-TTS 配音 → 分镜 → HTML 动画合成（KaTeX/SVG/GSAP，hyperframes 渲染）→ MP4 讲解视频；也可输出交互式 HTML 页面。纯 Skill，无 MCP。

与产品理念的张力必须说清楚：
- **可用窗口只在周末**（学校无屏幕），且**只能在延迟重做失败之后**提供——先给讲解视频等于投喂答案，直接摧毁"独立重做验证掌握"的闭环根基（PRD §15 伪需求反证：长篇 AI 讲解已被明确降级）。
- 但 pilot 假设四（"AI 讲解的真实需求有多大"）需要验证手段。edu-agent 是**现成的假设验证武器**：学生重做卡住且提示不够时，为其生成一个 1–2 分钟讲解视频，周末观察他是否主动看、看完能否做对。零自建成本。

另一个隐藏价值：它的工程资产对 **PDF 复习包质量**有直接参考——
- KaTeX 公式离线渲染的完整坑清单（CJK 豆腐块、JS 转义、字体自托管）；
- SVG 几何图形的数学精确性校验（坐标由约束计算而非目测）；
- **渲染后抽帧自查**的 QA gate 理念——与我们"证据核对不过不放行"是同一种工程纪律：不信"调用成功"，只信"产物被验证"。

### D. `omni-video2note` — 机制同构，暂不需要

教程视频 → 带审核状态的图文 PDF。方向与我们相反（我们是 照片→PDF），且住校生没有课堂录像来源。唯一值得带走的是它的失败纪律："理解失败就返回结构化失败，绝不凭空编造笔记"——我们已有同等原则。

### E. 不相关（明确排除）

`search`（我们刻意不做拍照搜题，反模式）、`video-memory` / `omni-memory` / `video-edit` / `omni-chatcut`（无视频素材）、`blender` / `freecad`（无 3D 需求）、`omni-skill-creator`（元工具）。

## 3. 行动建议（按优先级）

| # | 动作 | 目的 | 时机 |
|---|---|---|---|
| 1 | 在 WorkBuddy/CodeBuddy 安装 `api` 能力，用 `ocr`+`grounding` 跑真实验收照片做对照实验 | 定位"0 张通过"根因：管线 vs 模型 | **现在**，与真机验收并行 |
| 2 | 对照 `api`/`core` 的坐标与 EXIF 约定，审计我们 crop 全链路的坐标系一致性 | 消除 crop 错位隐患 | 本周 |
| 3 | 把 edu-agent 的 precheck/postcheck 清单（CJK 字体、KaTeX、抽帧自查）改编为复习包 PDF 的质量门禁 | 提升打印包可靠性 | 复习包真实打印验收前 |
| 4 | pilot 期间用 edu-agent 为"重做卡住"的题生成讲解视频（仅周末、仅重做失败后） | 验证假设四：AI 讲解的真实需求 | 真机验收通过后 |

## 4. 边界与风险

- 插件是开发/教研侧工具，不进入学生直接使用的链路；学生链路保持现有受控管线不变。
- 真实照片实验产生的图像数据遵守现有隐私约定（合成 fixture 进仓库，真实照片不留存、不进 git）。
- DashScope 临时 OSS 会保留上传媒体约 48 小时（`api` 插件文档明示）——真实学生照片走这条路要在隐私文档里写清楚，或强制走 inline 像素路径。
