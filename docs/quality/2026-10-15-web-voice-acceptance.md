# 网页版语音验收（2026-10-15）

范围：S2 的语音部分——核查既有 Qwen ASR 链路与浏览器录音容器匹配，在适合的输入场景复用同一语音入口，明确隐私提示与失败保底。不改动 `src/studentHost/`、`src/main.ts`、`src/mobile/cloudAssembly.ts`。

## ASR 请求与 MediaRecorder 容器核查（通过）

- 服务器：`src/v2/transcribe.ts` 只接受 `audio/mp4` / `audio/x-m4a` / `audio/m4a` / `audio/aac` / `audio/webm`，≤ 5 MB，MP4 容器可读时长时 ≤ 60 秒；仅内存处理，不落盘、不写日志。
- 模型：`src/ai/asr.ts` 固定调用百炼**原生** multimodal-generation 接口，`qwen-audio-3.1-asr-flash`；MIME → `parameters.format` 映射 mp4/x-m4a/m4a→m4a、aac→aac、webm→webm，与服务器接受列表一一对应。请求格式 2026-10-11 已用真实调用核实（见 `asr.ts` 注释：省略 sample_rate 后 16 k/44.1 k/48 k AAC 与 48 k Opus-WebM 均正确转写）。
- 浏览器：`CLIENT_SCRIPT`（`src/web/assets.ts`）的 `type()` 按 `['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']` 顺序取 `MediaRecorder.isTypeSupported` 的第一个——iOS Safari 产出 `audio/mp4`，Android Chrome 产出 `audio/webm`（Opus），均在服务器接受列表内；上传时 content-type 取 `blob.type` 去参数后的基础类型，与映射一致。**未发现容器不匹配，无需修改。**
- 已有测试覆盖（不重复造）：`tests/unit/asr.test.ts`（MIME 允许列表、时长上限、原生请求体、错误分类）、`tests/integration/webClient.test.ts`（/s/voice 鉴权、限流、不落盘）、`tests/e2e/webClient.spec.ts`（录音按钮开始/结束/转写回填）。

## 三个场景的结论

| 场景 | 结论 |
| --- | --- |
| 反思回答（说说为什么错） | 已有语音入口（`practice.tsx` WhyAskPage），本次只加固定隐私提示 |
| 题目修改指令（改一下） | 已有语音入口（`items.tsx` FixPage），本次只加固定隐私提示 |
| 报题号选择 | **没有现成的文字输入/解析入口**：网页版选题（ChoosePage）与勾题（PickPage）都是复选框提交 `itemIds`/`questionIds`，没有任何「输入题号」的文本框或解析逻辑。按约定不临时造语音题号解析，此场景不加语音入口。 |

## 本次改动

- `src/web/views/practice.tsx`、`src/web/views/items.tsx`：两处语音入口内加同一句固定提示「录音会发给通义千问转文字，本应用不保存录音；最多 60 秒，也可以直接打字」。
- `tests/unit/webVoiceSurfaces.test.ts`（新增）：两处入口的标记约定（目标输入框、`/s/voice`、提示文案）。行为验证复用既有集成和浏览器测试，不以脚本文本匹配代替行为验收。
- `docs/privacy/PRIVACY_AND_MINOR_DATA.md`：补充页面固定提示与失败保底说明。
- 行为保底（既有实现，未改）：转写结果只放进文本框，学生自己点提交；无麦克风能力时提示直接打字；拒绝权限/网络错误保留输入并允许键盘；录到 60 秒自动停。

## 验收状态

- 单元/集成/e2e 级：见上述测试；本次新增单测通过，typecheck 通过（结果见 `.superpowers/sdd/2026-10-15-student-web/s2-report.md`）。
- **真实手机（Safari）录音：未验收。** 本次在无真机的开发环境完成，Safari 实际产出容器的端到端转写、麦克风权限弹窗文案、60 秒截断在手机上的真实表现均未实测；需在手机上打开网页版实测后更新本文档。
- 真实模型（百炼密钥）端到端转写：Codex已在生产主机使用合成录音独立验证，见下节；未在开发日志中显示密钥。

## Codex 独立复核

2026-10-15 在线上使用纯合成中文句子“我把第十五题的负号看漏了，所以计算结果不对。”，经当前生产BailianTranscriber分别发送48k AAC/M4A和48k Opus/WebM；均成功转写“我把第15题的负号看漏了，所以计算结果不对。”，耗时701ms/562ms。此项验证真实模型和容器接口，不代替真机麦克风采集验收。页面文案仅承诺本应用不保存录音，不推断第三方留存政策。删除了三个仅匹配脚本文本的新增测试，保留两处页面披露渲染检查；行为沿用现有测试。
