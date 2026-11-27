# Super Error Log — 纸错题延迟重做闭环 MVP

面向寄宿制初三学生的错题复习闭环：**周末数字化，工作日纸质复习，下周末结果回传**。
当前学生用手机网页拍卷子：AI先找题，学生补勾遗漏，练习首页主动建议一小组题，学生查看题目或打印后在纸上重做，拍照提交并确认核对建议；也保留自己选题和直接录结果。当前原题重做闭环已实现；家长独立网页和变式题尚未接入。

## Codex Cloud 从这里接手

**唯一主分支：`main`。** 新任务从最新 `main` 开分支，PR 合并回 `main`；检查通过后自动上线。分支与未合并工作见[分支说明](docs/BRANCHES.md)。请先读[当前交接说明](docs/CODEX_CLOUD_HANDOFF.md)，里面包含环境安装、代码地图、测试命令和待办。

最近人工发布基线为 **0.5.0-r2**；当前线上版本以 [GitHub Actions](https://github.com/PCcoding666/Super_Error_Log/actions) 的成功发布和服务器 `current/deploy/ci-release.json` 为准。用户已确认手机上传成功，真实题目识别质量和完整一周使用仍待验收。[上传热修复记录](docs/quality/2026-10-15-photo-upload-hotfix.md)。

## 当前手机入口（学生邀请码）

手机Safari或Android浏览器打开 `https://study.pccoding666.com/s/`，输入自己的邀请码，即可进入独立学习空间；Safari可添加到主屏幕。无需Apple开发者账号安装，更新由服务器发布。语音使用千问ASR 3.1，结果可以编辑，再由学生提交。

本轮设计：[学生邀请码网页版](docs/superpowers/specs/2026-10-15-student-invite-web-design.md)；发布与验收状态：[交付记录](docs/quality/2026-10-15-student-web-release.md)。功能需 `SEL_STUDENT_HOST_ENABLED=1`；受控试用上限3个学生。下方原生App与本机演示说明保留作历史与开发参考。

学生怎么用见[学生使用指南](docs/product/STUDENT_GUIDE.md)；老师怎么发码、学生扫码一键进入、微信里怎么办、怎么放到桌面见[老师发码指南](docs/product/TEACHER_INVITE_GUIDE.md)；产品负责人自查用[走查方法](docs/product/WALKTHROUGH_GUIDE.md)，最近一次结果见[2026-10-22 学生视角走查](docs/quality/2026-10-22-student-walkthrough.md)。

## 管理后台（开发版本，尚未部署）

新增 `/admin/`，独立管理员登录后查看所有邀请码对应账号的使用、输入/输出 tokens、调用耗时、接口成功率和失败原因。支持按日期、账号、模型、功能筛选；旧数据无法恢复的指标标为“未采集”。管理员密码由服务器 CLI 的 `admin-password` 命令生成，详见[部署和登录说明](deploy/README.md#管理后台账号用量与-ai-性能2026-10-20-开发版本尚未部署)。

## 历史原生iPhone路径（本轮主要交付为上面的手机版网页）

原生应用位于 [`iOS/`](iOS/README.md)，主界面为中文。识别路径是 **iPhone 模拟器 → Mac 本机服务 → 百炼北京**；手机只保存本机配对令牌，不保存百炼密钥。选择照片先存本机，明确同意后才上传。真实候选与示例题分开，未通过检查的题不能确认或打印。

启动说明见 [iOS README](iOS/README.md)，接口见 [移动识别 API](docs/mobile-recognition-api.md)。请先阅读 [本轮实测结果与限制](iOS/VERIFICATION.md)：真实上传和返回已经验证，但仍有裁图和笔迹识别错误，不能据此认为十张照片已全部正确整理，也不能把合成测试中的复盘/PDF当成真实题目验收。

## 核心原则

- **AI 建议，学生决定**：AI 做提取、提示和作答初步核对；反思与练习结果必须由学生本人提交。
- **当场做对不算掌握**：只有延迟 3–7 天的独立重做正确才进入"暂时掌握"，7–14 天确认轮再做对才"稳定掌握"。
- **家长只见聚合**：家长视图只有完成率、学科掌握度、薄弱标签等聚合数字。

## 旧本地演示快速开始

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
| `npm run build && npm start` | 构建并启动旧本机演示；当前生产入口为 `dist/main.js` |

## 历史本地演示配置（当前生产配置见交接说明和部署文档）

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
- 当前交接：[Codex Cloud 接手说明](docs/CODEX_CLOUD_HANDOFF.md)；分支规则：[分支说明](docs/BRANCHES.md)
- 历史工程过程：`.ai/tasks/current/`（保留历史状态、决策、风险和测试日志，不代表当前上线状态）

## 技术栈

TypeScript · Express 5 · React 19 SSR（表单驱动，无 hydration）· node:sqlite（零原生依赖）· sharp（EXIF 转正/元数据剥离）· Playwright（A4 PDF 生成 + E2E）· Vitest
