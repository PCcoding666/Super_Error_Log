# 当前结构

学生用手机浏览器打开 `/s/`。界面在 `client/`（Ionic React），只服务 `/`、`/new`、`/me`、`/q/:id`。数据走 `/s/api`（`src/web/api.ts`）。`/s/native` 只给 iOS 客户端。

生产进程是 `src/main.ts`（构建后 `dist/main.js`）。真实 AI 缺配置时这里直接失败，不会退回 mock。

本机看学生端只走 `.claude/skills/verify-sel/SKILL.md`（`npm run verify:sel -- launch`）。全量检查是 `npm run verify`。

`npm run dev` 启动 `src/server.ts`，那是旧的本机演示，端口 3100，没有邀请码学生端。`npm run web:fake` 是旧的单学生夹具。都不要当成学生端的启动方式。

`src/web/views/` 里其余服务端页面仍挂在旧路径上，学生端没有入口。不要往那里加页面。练习在学生端是「即将推出」。

2026-09-05 的旧架构说明在 `ARCHIVE-2026-09-05-local-demo.md`，只作历史，其中的降级 mock 和 `src/server.ts` 入口已经作废。
