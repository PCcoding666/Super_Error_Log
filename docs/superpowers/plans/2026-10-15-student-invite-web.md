# 手机网页邀请码 Implementation Plan

> WorkBuddy 按任务实现；Codex 审查和验收。用户已选择执行方式并授权开发、上线和手机交付。

**Goal:** 手机直接开网址，每个学生凭邀请码进入独立学习空间。
**Architecture:** 在现有 /s/ 前加邀请会话网关，以独立进程/目录复用单学生服务；不在旧业务SQL中草率补过滤。
**Tech Stack:** TypeScript ESM、Node24、Express5、node:sqlite、SSR、PWA、Qwen-Audio-3.1-ASR-Flash。
**Spec:** ../specs/2026-10-15-student-invite-web-design.md

## S1 邀请码、会话和独立学生服务（WorkBuddy）
- [ ] 新建 src/studentHost/registry.ts：StudentRegistry，学生空间上限3；issue/redeem/authenticate/revoke，安全随机与事务。
- [ ] 新建 src/studentHost/admin-cli.ts：create/list/invite/revoke-sessions，码只在生成时输出，不入日志。
- [ ] 新建 src/studentHost/worker.ts、workers.ts：child_process.fork、IPC ready(port,token)、每学生独立env/dir；有界启动、恢复、退出和令牌刷新。
- [ ] 新建 src/studentHost/router.ts：公开静态资源与登录页、同源POST兑换/退出，流式代理学生路径；权限和路径严格隔离。
- [ ] 最小修改 src/mobile/cloudAssembly.ts 与 src/main.ts：仅flag启用、CloudAssembly端口/生命周期钩子；worker不能递归启动host。保持现有装配测试兼容。
- [ ] 测试 tests/integration/studentHost.test.ts：双学生数据/文件/作业/打印隔离，重启、撤销、并发兑换、路径攻击、伪造cookie/header、body流转发、启动失败、容量满。测试走真实网关和worker，允许合成provider但不假装真实模型。
- [ ] typecheck/build/针对性测试；写交付报告列出未解决问题，不提交不推送不部署。

## S2 登录/安装体验及语音验收（WorkBuddy，S1后）
- [ ] 保留现有视觉语言，输入码分组/粘贴可用，错误清晰；退出按钮及设置中主屏幕安装引导。
- [ ] Qwen 3.1 ASR 验证现有请求格式；Safari/Android MIME检查；更新录音发送百炼说明；键盘输入保底。
- [ ] 浏览器覆盖登录→拍照/选题→追问→打印→回传与退出，公共PWA资源可安装、不缓存学习内容。
- [ ] 更新 deploy/README.md、.env.example、发布检查单、唯一当前状态文档；记载独立空间及CLI和回滚。

## S3 独立审查与发布（Codex）
- [ ] 审查隔离/路径/worker生命周期/私密内容/兼容；返修后针对性回归。
- [ ] npm run verify 全通过；新增浏览器验收、合成音频真实ASR验证。
- [ ] 已授权部署：确认基线、备份、打包校验、上线、新码和旧API验证；不推送。
- [ ] 手机上打开网页，完成专属码登录、添加主屏幕；逐项记录可观察证据与需人操作处。

## Review Focus
1. 全局db/config/provider异步串用户 → 独立进程真实双用户测试。
2. 代理路径逃逸及伪造cookie → 拦截旧pair/v1/v2和编码路径，隔离测试。
3. 登出/换号残留数据 → no-store、SW缓存检查、清业务Cookie。
4. 请求中断/worker退出 → multipart无重复写、有限重试（POST不自动重放）。
5. 邀请事务并发/令牌过期 → 单用、重启、撤销与内部令牌更新测试。
