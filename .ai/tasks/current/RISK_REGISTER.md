# RISK REGISTER — 风险登记

| ID | 风险 | 等级 | 状态 | 缓解 |
|---|---|---|---|---|
| R1 | 旧 git 历史中含 secret（POC/.../.env 曾提交） | High | OPEN | 本次不做 git 写操作；HANDOFF 中提示仓库所有者轮换密钥并清理历史 |
| R2 | 疑似 GCP 服务账号密钥 json 曾入仓库 | Critical | OPEN（已隔离） | 文件已移至 preserved；需所有者吊销该密钥；不得读取内容 |
| R3 | 疑似真实上传图片（或含未成年人数据）曾在 static/uploads | High | OPEN（已隔离） | 已隔离；不得加入新仓库；fixture 全部合成 |
| R4 | npm 网络不可用导致无法安装依赖 | Medium | UNKNOWN | 首次 install 验证；失败则评估离线替代 |
| R5 | PDF 中文字体在 headless Chromium 渲染异常 | Medium | UNKNOWN | Phase 4 用真实渲染检查；macOS 系统 CJK 字体通常可用 |
| R6 | Agent 上下文压缩导致状态丢失 | Medium | MITIGATED | `.ai/tasks/current/` 持久化 + 每轮 checkpoint |
| R7 | 答题卡与试卷分离场景（题目在试卷、作答在答题卡，需跨照片关联）未被提取逻辑覆盖；当前假设「题目与作答同页」 | Medium | OPEN（用户决策暂缓，2026-09-19） | 真实遇到该 case 时再设计；届时需支持跨照片关联同一题 |
| R8 | 进度展示体验不足：Web 批次进度条为 SSR 静态渲染不自动刷新（需手动刷页面）；iOS 上传阶段仅一行文字无上传进度 | Low | 部分解决（2026-09-20） | Web：Layout 加 refreshSeconds，处理中的批次详情页/首页 3 秒 meta refresh 自动刷新；iOS：上传进度条+状态卡已完成（任务3）。剩：iOS 端真机回归确认 |
