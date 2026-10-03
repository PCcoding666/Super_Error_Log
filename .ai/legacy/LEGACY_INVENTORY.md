# 旧仓库清理清单（LEGACY INVENTORY）

生成时间：2026-09-05
项目根目录：/Users/chengpeng/MyProject/Super_Error_Log（已验证真实路径）
清理前分支：codex/ai-error-review-mvp，HEAD=e8ffe8b "feat: build AI error review loop MVP"（实为旧 Flask 实现的修改，非新 MVP）

## 旧实现概况（132 个文件）

- `SuperErrorLog/` — Flask Web 应用（app.py、run.py、templates/、static/、services/、database/、utils/、tests/）
- `SuperErrorLog_iOS/` — SwiftUI iOS 客户端
- `POC/` — Gradio/VLM 实验代码（pipline.py、gradio_intergrate.py、vlm_api_testing/、Reasoning_Compliance_Assessment/）
- `src/` — 早期 JS 前端残留（app、components）
- `README.md`、`.pytest_cache/`、`.benchmarks/`、`.gradio/`、各级 `__pycache__/`

## 处理动作

1. 已删除：以上全部旧源代码、模板、测试、依赖配置与构建/缓存产物。**未复用其架构或代码**。git 历史保留，可回溯。
2. 已保留：`.git/`、`.gitignore`（后续重写）、`AGENTS.md`（后续重写）。
3. 已隔离（未读取内容、未删除、未复用，移动至 `.ai/legacy/preserved/` 并排除出构建）：

| 原路径 | 风险类型 |
|---|---|
| POC/vlm_api_testing/.env | 疑似 secret |
| POC/Reasoning_Compliance_Assessment/.env | 疑似 secret（且曾提交进 git 历史） |
| POC/vlm_api_testing/crypto-galaxy-407901-55c76baa3f01.json | 疑似云服务账号密钥 |
| POC/vlm_api_testing/temp_file/ (2 张图片) | 疑似真实用户图片 |
| SuperErrorLog/config.py | 可能含硬编码密钥 |
| SuperErrorLog/data/*.db (3 个) | 用户数据 |
| SuperErrorLog/logs/app.log | 可能含用户数据 |
| SuperErrorLog/static/uploads*/ (5 张图片) | 疑似真实上传图片（可能涉及未成年人） |

## 遗留风险

- 部分 secret 文件曾提交进 git 历史（如 `POC/Reasoning_Compliance_Assessment/.env`）。本次不做 git 写操作，需仓库所有者后续自行清理历史并轮换密钥。详见 RISK_REGISTER。
- 清理后工作区仅剩 `.ai/`、`.git`、`.gitignore`、`AGENTS.md`，已二次验证边界无越界删除。
