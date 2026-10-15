# 分支与本地目录

## 从哪里开发

**`main` 是唯一长期主分支，也是 GitHub 默认分支和自动发布来源。**

1. 更新 `main`，从它新建 `codex/<任务名>`。
2. 开发后提 PR 到 `main`，检查通过并 review 后合并。
3. `main` 的检查通过后自动上线；以 Actions 发布结果和服务器版本记录确认成功。
4. 合并后删除任务分支。代码和讨论仍保留在提交历史、PR 中。

不用再保留一套长期 `develop` / `release` 分支。版本留存用标签，未完成工作用独立任务分支。

## 已审查整合的 R2 工作

原 `feat/web-quality-r2`（`04113f5`，27 条提交）通过 [PR #13](https://github.com/PCcoding666/Super_Error_Log/pull/13) 与最新 `main` 对齐。逐条取舍、修复和验收见 [PR #13 审查记录](quality/2026-10-15-pr13-review.md)。不要再从该旧分支开新任务；合并前以 PR 状态为准，合并后当前实现随 `main`。

原始未修改版本另有 `archive/pr13-before-review-2026-10-15` 标签。跨页面过渡及其错误屏蔽、正则脚本压缩未采用；Caddy 响应压缩暂缓。其余改进与邀请码、照片上传修复一起验收。

## 已保存的设计

原 `design/student-ui-redesign` 分支的提交 `ed5be3f` 已连同历史合入：

- [2026-10-06 学生界面设计](superpowers/specs/2026-10-06-student-ui-redesign/design.md)
- [可点击原型](superpowers/specs/2026-10-06-student-ui-redesign/mockup/index.html)

两份文件原样保留，用于历史参考，不代表所有设计都已实现，也不是新一轮改版指令。

## 旧版本和恢复

- `archive/main-before-2026-10-15`：整理前的早期 `main`（`78f8a10`）。
- `archive/production-before-main-2026-10-15`：迁移前的已发布版本（`5108b77`，PR #11 合并结果）。
- PR #2–#11 的已合并任务分支在迁移完成后删除；提交历史不重写。

本次整理获用户明确授权。操作前在本机 `~/ProjectArchives/Super_Error_Log/` 建立私有归档，含所有分支的 Git bundle、全部工作副本的完整 tar、文件核对记录、SHA256、原分支和目录清单、仓库设置。真实资料、配置和工作日志不上传 GitHub。

本地主目录保留在 `~/MyProject/Super_Error_Log`；R2 副本用于 PR #13 审查，完成后可归档。已完成的旧副本移入私有归档，恢复时先阅读归档的 `RESTORE.md`；不要把旧 `.git` 指针直接当作有效工作副本使用。

## 自动发布绑定点

迁移分支名必须同时核对以下位置，不能只修改 GitHub 默认分支：

- `.github/workflows/ci.yml`：仅 `main` push 可以进入部署。
- `.github/workflows/deploy.yml`：再次限定 `refs/heads/main`。
- `deploy/ci/publish.sh`：核对最新 `main` 提交，跳过被新提交替代的发布。
- GitHub `production` 环境：只允许 `main`。
- `main` 的分支保护：至少要求服务端检查，禁止强推和删除。

密钥、学生资料、部署账号和回退机制沿用既有配置。当前部署以 [发布说明](../deploy/ci/README.md) 为准。
