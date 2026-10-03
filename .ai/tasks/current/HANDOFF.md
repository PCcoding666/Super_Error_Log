# HANDOFF — 交接说明

## 当前状态
MVP 0.1.0 完成。P0–P6 全部闭环：单元 33 + 集成 25 + E2E 9 全绿，typecheck/build 通过。
独立代码审查（code-inspector）发现的 2 阻塞 + 4 重要项已全部修复或文档化（见 REVIEW.md、DECISIONS D4–D7）。
工作区未提交 git（按约束）。进度以本目录状态文件为准。

## 运行命令
```bash
npm install
npm run demo      # 一键演示（生成夹具 + mock 模式启动，http://localhost:3100）
npm run verify    # 全量验证：typecheck + 单测/集成 + build + E2E
```
演示数据：`fixtures/assets/week1/`（19 文件 / 20 题，含 3 道低置信、1 张 EXIF 旋转、1 个双页 PDF）。

## 架构速览
- `src/domain/` 纯函数：状态机（11 态）、评分（0–100 可解释）、排期（5–8 题、同标签上限 2、延迟窗口）
- `src/services/` 编排：batch（上传/去重/重试）、item（校正/反思/归档）、plan（推荐/建包）、pdf（Playwright A4）、attempt（回传/掌握事件）、trend（聚合）
- `src/ai/` Provider 契约：mock（manifest + 哈希伪随机 + 故障注入）/ openai（OpenAI 兼容 + 错误分类重试）
- `src/routes/` + `src/views/`：Express 5 + React 19 SSR（表单驱动，无 hydration）；`sel_role` Cookie 角色隔离
- 数据：`SEL_DATA_DIR`（SQLite WAL + uploads + packets）

## 已知限制
- mock 模式下 AI 提取为合成数据；真实识别质量需 openai 模式冒烟（发布检查单）
- 回传照片匹配仅按文件名/短 ID 启发式（mock）；真实模式待验证
- PDF 中 PDF 原件页不内嵌（>8MB 或 PDF 资产跳过图片内嵌，仅显示文本摘要）
- 角色切换无密码（家庭自用单机假设，D6/A16）；多学生单档案
- 上传走内存缓冲，最坏约 450MB（15MB×30 文件）；本地单机可接受，部署到受限环境需改磁盘流式
- E2E 仅 Chromium 移动视口；真实打印效果未做视觉确认

## 下一轮最高风险事项
- R2：吊销疑似泄露的 GCP 密钥（需仓库所有者执行；见 RISK_REGISTER）
- R1：git 历史中旧 secret 残留（重建历史或作废密钥二选一）
- 真实 AI 模式冒烟 + 真实打印确认（docs/quality/RELEASE_CHECKLIST.md）
