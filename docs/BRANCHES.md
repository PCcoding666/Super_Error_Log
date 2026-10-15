# 分支与本地目录

## 从哪里开发

**`main` 是唯一长期主分支，也是 GitHub 默认分支和自动发布来源。**

1. 更新 `main`，从它新建 `codex/<任务名>`。
2. 开发后提 PR 到 `main`，检查通过并 review 后合并。
3. `main` 的检查通过后自动上线；以 Actions 发布结果和服务器版本记录确认成功。
4. 合并后删除任务分支。代码和讨论仍保留在提交历史、PR 中。

不用再保留一套长期 `develop` / `release` 分支。版本留存用标签，未完成工作用独立任务分支。

## 特别保留的未合并工作

`feat/web-quality-r2`：第二轮网页改进，保存时为 `04113f5f077175c8e9057cdc856c2c253d98baec`，含 27 条未合并提交。

内容包括等待状态刷新、录音音量和计时、打印预览、资源缓存、放大后的排版及相关验证材料。**这批工作未随本次整理上线。** 接手者先与最新 `main` 对齐，检查与邀请码隔离、图片上传修复、首页刷新是否冲突，再提交审查；不要直接覆盖正式版本。其合并是否就绪以 PR 的实际审查结果为准。

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

本地主目录保留在 `~/MyProject/Super_Error_Log`；未完成的 R2 副本单独保留。已完成的旧副本移入私有归档，恢复时先阅读归档的 `RESTORE.md`；不要把旧 `.git` 指针直接当作有效工作副本使用。

## 自动发布绑定点

迁移分支名必须同时核对以下位置，不能只修改 GitHub 默认分支：

- `.github/workflows/ci.yml`：仅 `main` push 可以进入部署。
- `.github/workflows/deploy.yml`：再次限定 `refs/heads/main`。
- `deploy/ci/publish.sh`：核对最新 `main` 提交，跳过被新提交替代的发布。
- GitHub `production` 环境：只允许 `main`。
- `main` 的分支保护：至少要求服务端检查，禁止强推和删除。

密钥、学生资料、部署账号和回退机制沿用既有配置。当前部署以 [发布说明](../deploy/ci/README.md) 为准。
