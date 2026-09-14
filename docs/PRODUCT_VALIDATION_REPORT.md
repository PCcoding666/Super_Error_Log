# 产品验证报告

日期：2026-09-05 · 版本：MVP 0.1.0 · AI 模式：mock（确定性，无 API Key）

## 自动化验证证据

| 层 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | 通过（strict + noUncheckedIndexedAccess） |
| 单元测试 | `npx vitest run tests/unit` | 33/33（状态机 14、评分 5、排期 8、mock Provider 6） |
| 集成测试 | `npx vitest run tests/integration` | 23/23（Slice A 8、Slice B 7、Slice C 8） |
| E2E 旅程 | `npx playwright test` | 9/9（J1–J8，Chromium 390×844） |
| 构建 | `npm run build` | 通过 |

## J1–J8 验收结论

- **J1 建档**：三科设置 + 隐私确认强制勾选；E2E 通过。
- **J2 采集**：19 文件 → 20 题，3 道低置信进入校正；EXIF 旋转自动转正；空/不支持/损坏文件各有明确状态且不阻塞整批。
- **J3 反思**：四项必选；AI 提示仅展示不预选；`submittedBy≠student` 服务端拒绝。
- **J4 复习包**：默认勾选 8 题，每题显示评分与理由；PDF 经 pdf-lib 校验为 A4，pdfjs 文本层校验题目页无提示/答案原文、答案章独立在最后；演算区与勾选框齐全。
- **J5 回传**：独立做对/使用提示/做错/未完成分别流转为 attempted/needs_recheck，回传页可见已记录。
- **J6 掌握**：当场做对不产生掌握事件；延迟 4 天独立做对 → 暂时掌握（写入 next_review_at 7–14 天窗口）；确认轮再做对 → 稳定掌握；同知识点/错因复发预警在趋势页可见。
- **J7 降级与边界**：无 Key 自动 mock 且首页可见"演示模式"；超时 → failed → 重试成功且幂等；重复上传全部标记重复。
- **J8 权限**：家长态访问学生页面/API 返回 403；家长聚合 JSON 不含题目原文、提示、答案与反思状态。

## 过程中发现并修复的问题

1. `source_asset(batch_id, content_hash)` 唯一索引与被拒资产占位 hash 冲突 → 降为普通索引（应用层去重已幂等）。
2. `parentAggregate` 周完成统计在一题多次作答时被 JOIN 放大（8 题显示 9）→ 改 COUNT(DISTINCT)。
3. 新数据目录下 uploads/packets 目录缺失导致上传 ENOENT → 目录函数自创建。
4. Playwright 健康检查被本机代理变量劫持（502）→ 配置中清理代理变量。
5. React `<title>` children 数组告警 → 模板字符串。

## 结论

MVP 在 mock 模式下全流程可运行、可重复验证。可进入试点准备阶段；真实 AI 接口冒烟与真实打印确认列入发布检查单。
