# Super Error Log — 纸错题延迟重做闭环 MVP

面向寄宿制初三学生的错题复习闭环：**周末数字化，工作日纸质复习，下周末结果回传**。
学生周末批量拍照上传错题，AI 识别提取，学生本人完成四项最小反思，系统按可解释规则选出 5–8 道生成 A4 黑白打印复习包；学生带纸质包到校独立重做，下周末回传结果，系统据此更新掌握度；家长只看到聚合趋势，看不到题目与反思内容。

## iPhone 应用：中文真实识别试验版

原生应用位于 [`iOS/`](iOS/README.md)，主界面为中文。识别路径是 **iPhone 模拟器 → Mac 本机服务 → 百炼北京**；手机只保存本机配对令牌，不保存百炼密钥。选择照片先存本机，明确同意后才上传。真实候选与示例题分开，未通过检查的题不能确认或打印。

启动说明见 [iOS README](iOS/README.md)，接口见 [移动识别 API](docs/mobile-recognition-api.md)。请先阅读 [本轮实测结果与限制](iOS/VERIFICATION.md)：真实上传和返回已经验证，但仍有裁图和笔迹识别错误，不能据此认为十张照片已全部正确整理，也不能把合成测试中的复盘/PDF当成真实题目验收。

## 核心原则

- **AI 建议，学生决定**：AI 只做提取与提示，反思必须由学生本人提交。
- **当场做对不算掌握**：只有延迟 3–7 天的独立重做正确才进入"暂时掌握"，7–14 天确认轮再做对才"稳定掌握"。
- **家长只见聚合**：家长视图只有完成率、学科掌握度、薄弱标签等聚合数字。

## 快速开始

```bash
npm install
npm run demo        # 生成演示夹具并启动（mock 模式，无需 API Key）
# 打开 http://localhost:3100
```

演示数据：`fixtures/assets/week1/` 下有 19 个合成错题文件（17 PNG + 1 张 EXIF 旋转 JPEG + 1 个双页 PDF，共 20 题）。首页上传即可走完整流程。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发服务器（tsx watch，默认端口 3100） |
| `npm run demo` | 生成夹具 + 启动，一键演示 |
| `npm test` | 单元 + 集成测试（Vitest） |
| `npm run test:e2e` | E2E 旅程测试 J1–J8（Playwright，端口 3199） |
| `npm run verify` | typecheck + 单测/集成 + 构建 + E2E 全量验证 |
| `npm run build && npm start` | 生产构建与启动 |

## 配置

不配置环境变量时为本地 Mock 演示。真实使用请复制 `.env.example` 为 `.env` 并在本机填写百炼 Key 与对应地域 URL；示例使用 `SEL_AI_MODE=bailian`、`qwen3.8-27b` 和独立 `data/real` 目录。真实模式缺配置会失败，不会降级成 Mock。其他兼容服务可显式选择 `openai`。

真实照片走多模态证据链：HEIC/图片归一化 → 完整题目定位 → 题干、图示、原始作答、订正与批注分开提取 → 原图清单与实际裁图的逐项完整性检查 → 学生校对 → 按证据生成候选诊断和 AI 参考提示 → 学生本人反思 → 干净打印 → 按实际作答日期回传。所有真实提取结果都需校对；只有确认不含作答的图示可进入打印题面。AI 参考不等于教师核验答案。

[裁图完整性说明](docs/CROP_COMPLETENESS.md)：调用 `succeeded` 不代表内容通过；缺失、不确定、未检查及过期结果不能自动进入确认、诊断或打印。改框使旧检查失效。模型误报须逐项、有依据地人工复核，保留原模型判定；自动检查不是视觉准确率的保证。

阶段模型对比使用 [评测说明](docs/REAL_MODEL_EVALUATION.md)。测试中的合成响应不是百炼实测；没有密钥、费用上限和人工核对结果时不会生成“最佳模型”结论。

## 文档

- 产品：`docs/product/`（PRD、页面规格、试点协议、假设登记）
- 架构：`docs/architecture/`（架构、数据模型、AI Provider 契约）
- 质量：`docs/quality/`（测试策略、发布检查单）
- 隐私：`docs/privacy/PRIVACY_AND_MINOR_DATA.md`
- 用户手册：`docs/MVP_USER_MANUAL.md`
- 验证报告：`docs/PRODUCT_VALIDATION_REPORT.md`
- 工程过程：`.ai/tasks/current/`（状态、决策、风险、测试日志）

## 技术栈

TypeScript · Express 5 · React 19 SSR（表单驱动，无 hydration）· node:sqlite（零原生依赖）· sharp（EXIF 转正/元数据剥离）· Playwright（A4 PDF 生成 + E2E）· Vitest
