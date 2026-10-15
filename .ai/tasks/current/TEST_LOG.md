# TEST LOG — 测试与验证证据

| 时间 | 阶段 | 命令/检查 | 结果 | 证据 |
|---|---|---|---|---|
| 2026-09-05 | P0 | `pwd && ls -la` | PASS | 根目录正确，旧结构识别 |
| 2026-09-05 | P0 | `git show --stat HEAD` | PASS | HEAD 为旧 Flask 实现修改，无可复用 MVP |
| 2026-09-05 | P0 | 敏感文件路径扫描（find，未读内容） | PASS | 发现 .env×2、疑似GCP密钥json、db×3、上传图片×7、log |
| 2026-09-05 | P0 | 隔离移动 15 文件至 `.ai/legacy/preserved/` | PASS | find 输出逐一核对 |
| 2026-09-05 | P0 | 删除旧实现 + `git status` | PASS | 工作区仅剩 .ai/.git/.gitignore/AGENTS.md |
| 2026-09-05 | P0 | 环境审计 node/npm/pnpm/playwright | PASS | Node 26.4、npm 11.17、Playwright 1.62.1、Chromium 已缓存 |
| 2026-09-05 | P2 | `npm run fixtures:generate` | PASS | 19 文件（17 PNG + EXIF JPEG + 双页 PDF），manifest 20 题 |
| 2026-09-05 | P2 | `npm run dev` + curl /api/health | PASS | `{ok:true, aiMode:'mock', degraded:false}`；onboarding POST 建档案 |
| 2026-09-05 | P3 | `npx vitest run tests/unit` | PASS | 33/33（stateMachine 14、scoring 5、scheduling 8、mockProvider 6） |
| 2026-09-05 | P3 | sliceA 边界用例 UNIQUE 冲突 | FAIL→修复 | 根因：idx_asset_batch_hash 为 UNIQUE，被拒资产 content_hash='-' 与批内重复撞约束；修复：降普通索引（应用层去重已幂等） |
| 2026-09-05 | P3 | `npx vitest run tests/integration/sliceA.test.ts` | PASS | 8/8：上传 19 文件→20 题、3 低置信、去重、边界、EXIF、超时重试幂等、订正、反思、AI 代写拒绝 |
| 2026-09-05 | P3 | `npx vitest run && npm run typecheck` | PASS | 41/41，tsc --noEmit 无错误 |
| 2026-09-05 | P4 | sliceB 集成（推荐/建包/HTML 答案分离/pdf-lib A4 校验/pdfjs 文本层） | PASS | 7/7；A4=595.28×841.89pt；题目页无提示/答案原文 |
| 2026-09-05 | P4 | parentAggregate 周完成数 JOIN 放大 | FAIL→修复 | 一题多次作答时 8 题显示 9；改 COUNT(DISTINCT) |
| 2026-09-05 | P5 | sliceC 集成（回传归属/当场不掌握/延迟掌握/确认轮/趋势/归档门禁/家长聚合内容） | PASS | 8/8 |
| 2026-09-05 | P6 | Playwright webServer 健康检查 502 | FAIL→修复 | 根因：本机 HTTP_PROXY+NODE_USE_ENV_PROXY 无 NO_PROXY，探测走代理；config 中清理代理变量 |
| 2026-09-05 | P6 | E2E 上传 ENOENT | FAIL→修复 | 根因：新数据目录下 uploads/ 未创建；config 目录函数自创建 |
| 2026-09-05 | P6 | `npx playwright test`（J1–J8） | PASS | 9/9，Chromium 390×844 |
| 2026-09-05 | P6 | `npm run verify` | PASS | typecheck + 56 vitest + build + 9 E2E 全绿 |
| 2026-09-05 | P6 | `npm run demo` 冒烟 | PASS | 夹具生成 + 启动 + /api/health + / → /onboarding |
| 2026-09-05 | P6 | 独立代码审查（code-inspector） | 2 阻塞+4 重要 | 回传刷分直通稳定掌握、回传照片路径传错、PDF 重生成回退状态、角色无强制力、窗口常量未用、processBatch 无并发守卫 |
| 2026-09-05 | P6 | 审查修复 + sliceC 新增 3 回归用例 | PASS | 同包重复回传拒绝 / 确认轮走新包 stably_mastered / 重生成不回退状态 |
| 2026-09-05 | P6 | 修复后 `npm run verify` | PASS | typecheck + 58 vitest（33 单元+25 集成）+ build + 9 E2E 全绿 |
| 2026-09-06 | 审查R2 | 第二轮外部审查 4×P1 + 4×P2 逐条核对源码 | 8/8 接受 | 绑定地址、重置残留、created_at 起算、attempted 死状态、backlogMissed 恒真、批次漏算、packet 不到 returned、extract 无校验 |
| 2026-09-06 | 审查R2 | F1–F8 修复 + 新增回归用例 | PASS | sliceC +3（未生成拒绝回传/attempted 复推/returned 流转）；新单测 extractValidation 14、finalizeBatch 4、resetAllData 1 |
| 2026-09-06 | 审查R2 | 修复后全量验证 | PASS | typecheck ✓；vitest 80/80（47 单元+33 集成）；build ✓；playwright 9/9 ✓ |
