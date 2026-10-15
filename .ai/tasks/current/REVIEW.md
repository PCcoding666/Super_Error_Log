# REVIEW — 验收证据与审查记录

（每项标注 CONFIRMED / LIKELY / UNKNOWN 及证据路径）

## Phase 0
- [x] 路径安全：pwd 验证 = 项目根目录（CONFIRMED，TEST_LOG）
- [x] 旧实现不参与构建：已物理删除，git status 全量 D（CONFIRMED）
- [x] 无越界删除：仅项目根目录内操作；15 敏感文件隔离未读未删（CONFIRMED，.ai/legacy/LEGACY_INVENTORY.md）
- [x] 新项目可初始化：npm install 成功，骨架启动（CONFIRMED）

## Phase 1
- [x] PRD/SPEC/PILOT/ASSUMPTION 与学生事实一致；无 AI 代反思；无工作日屏幕依赖（CONFIRMED，docs/product/）

## Phase 2
- [x] 本地可启动；/api/health 通过；mock 无 Key 可运行（CONFIRMED，TEST_LOG P2 行）

## Phase 3（Slice A）
- [x] 20 题全流程、幂等、错误可恢复：集成 8/8（CONFIRMED，tests/integration/sliceA.test.ts）
- [x] 修复：asset 唯一索引过严（CONFIRMED，src/db/schema.ts）

## Phase 4（Slice B）
- [x] 推荐可解释、5–8 题、A4、答案分离：集成 7/7 + pdf-lib/pdfjs 程序校验（CONFIRMED，tests/integration/sliceB.test.ts）
- [x] 修复：parentAggregate DISTINCT（CONFIRMED，src/services/trendService.ts）

## Phase 5（Slice C）
- [x] 回传流转、延迟掌握、确认轮、归档门禁、家长聚合无泄露：集成 8/8（CONFIRMED，tests/integration/sliceC.test.ts）

## Phase 6
- [x] E2E J1–J8 全绿 9/9（CONFIRMED，tests/e2e/journey.spec.ts）
- [x] 修复：uploads 目录 ENOENT、Playwright 代理 502（CONFIRMED，src/config.ts、playwright.config.ts）
- [x] `npm run verify` 全绿；`npm run demo` 冒烟通过（CONFIRMED，TEST_LOG）
- [x] 文档齐备：README/手册/验证报告/测试策略/发布检查单/隐私说明（CONFIRMED，docs/）
- [x] 独立代码审查：code-inspector 完成，2 阻塞 + 4 重要 + 5 建议，全部处置（CONFIRMED，见下）

## 独立审查结论（2026-09-05）

### 阻塞项（已修复并回归）
1. **回传可刷分直通稳定掌握**：`review_attempt` 无 (packet_id,item_id) 唯一约束，同包二次"独立做对"被当作确认轮。修复：唯一索引 + recordAttempt 拒绝同包重复回传 + 确认轮必须经由新复习包（reviewableItems 纳入到期 temporarily_mastered；createPacket 保留其状态，见 D4/D7）。回归：sliceC 新增"同包重复回传被拒绝""确认轮（新复习包）"。
2. **回传照片 imagePath 传错**：路由把客户端文件名当服务器路径传给 provider，真实模式必失败（被 mock 按文件名匹配所掩盖）。修复：MatchInput 增加 originalName，imagePath 传真实临时路径，临时文件名加 UUID 防互覆。

### 重要项（已修复 / 文档化）
3. 重生成 PDF 无条件回退题目状态 → 仅 scheduled → packet_generated，且包状态限 scheduled/generated。回归：sliceC"重新生成 PDF 不回退"。
4. 角色自声明无强制力 → 明示为 MVP 假设（D6/A16），隐私文档加注，升级路径为家长口令。
5. 延迟窗口上限未使用 → 删除未用常量，决策记录 D5（延迟越久证据越强，上限无依据）。
6. processBatch 无并发守卫 → 进程内 in-flight Set，重入直接返回。

### 建议项（已修复 4 / 接受 1）
- 路径前缀校验补 path.sep（mediaHandler + PDF 下载）✅
- requireStudent 用 originalUrl 判断 /api/（此前家长访问 API 拿到 HTML 而非 JSON 403）✅
- 回传 completion/correct 白名单校验 ✅；不可作答状态插入 orphan attempt 行 ✅（ATTEMPTABLE_STATUSES 前置拦截）
- multer 最坏 ~450MB 内存：接受为 MVP 已知限制（本地单机），记录在 HANDOFF

### 审查确认无问题的面
SQL 注入（全参数化）、XSS（JSX 转义 + printPacket esc 全覆盖）、日志隐私（仅事件名+ID）、家长聚合无原文/反思、批次幂等、Chromium 无泄漏。

### 回归证据
修复后 `npm run verify` 全绿：typecheck + 58 vitest（33 单元 + 25 集成）+ build + 9 E2E（J1–J8）。

## 第二轮外部审查结论（2026-09-06，8 条全部接受）

### P1（已修复并回归）
1. **服务绑定 127.0.0.1**：listen 未指定 host 时默认监听所有接口，局域网可访问且默认角色即学生。修复：config.host = SEL_HOST ?? '127.0.0.1'，server.ts 显式绑定。
2. **重置残留文件**：/settings/reset 只清库和 uploads/，已生成 PDF 与事件日志残留。修复：resetAllData() 一并删除 packets/ 与 events.log。回归：tests/unit/resetAllData.test.ts。
3. **延迟窗口从 created_at 起算**：建包≠拿到 PDF，可能"当场"直通掌握。修复：review_packet 增加 generated_at（含 ALTER TABLE 迁移），pdfService 生成时打点，recordAttempt 以 generated_at ?? created_at 计算间隔，且未生成 PDF 的包拒绝回传。回归：sliceC「未生成 PDF 的复习包拒绝回传」。
4. **attempted 死状态**（第一轮修重复回传时引入的回归）：当场做对的题永远不再被推荐。修复：reviewableItems 纳入 attempted，推荐理由「当场做对不计掌握：需延迟独立重做验证」。回归：sliceC「当场做对（attempted）的题目下周仍进入推荐」。

### P2（已修复并回归）
5. **backlogMissed 恒真**：Boolean(对象) 永远 true。修复：`.n > 0`。
6. **批次状态漏算**：finalizeBatch 只数 'failed'，empty/unsupported/too_large 不算失败。修复：计入失败；duplicate 仍为成功跳过。回归：tests/unit/finalizeBatch.test.ts（4 例）。
7. **packet 永远不到 returned**：全部回传后首页仍当待回传。修复：recordAttempt 内检查包内剩余未答数，为 0 时置 returned 且不再接受回传。回归：sliceC「全部题目回传后复习包状态变为 returned」。
8. **openaiProvider extract 无运行时校验**：畸形 JSON 直接入库。修复：新增 src/ai/validate.ts 严格校验（itemIndex/textExcerpt/knowledgeTags/confidence∈[0,1]/fieldConfidence），不合法抛 AiError('invalid_json') 走重试/转人工。回归：tests/unit/extractValidation.test.ts（14 例）。

### 回归证据
修复后全量验证：typecheck ✓；vitest 80/80（47 单元 + 33 集成，新增 22 例）；build ✓；Playwright E2E 9/9（J1–J8）✓。
