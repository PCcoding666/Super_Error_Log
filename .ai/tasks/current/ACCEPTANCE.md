# ACCEPTANCE — 验收标准（Definition of Done）

## 阶段门

- [x] Phase 0：路径安全；旧实现不参与构建；无越界删除；新项目可初始化
- [x] Phase 1：PRD/SPEC/PILOT/ASSUMPTION 与已确认事实一致；无 AI 代反思；无工作日屏幕依赖
- [x] Phase 2：本地可启动；健康检查通过；无 Key mock 模式可运行
- [x] Phase 3：20 道合成错题全流程（上传→提取→校正→反思）；重复上传幂等；错误可恢复（sliceA 8/8）
- [x] Phase 4：PDF 可下载；黑白可读；无答案泄露；条目可追踪（sliceB 7/7 + pdf-lib/pdfjs 校验）
- [x] Phase 5：失败题进下次包；延迟独立成功→暂时掌握；家长看不到私人反思（sliceC 8/8）
- [x] Phase 6：新用户按手册可完成 demo；全量质量命令通过；限制如实记录

## 核心 E2E 旅程（J1–J8）

- [x] J1 首次使用：匿名学生档案、三科设置、隐私边界说明
- [x] J2 周末批量采集：20 道合成错题多图/PDF、进度可见、低置信度标记、可校正
- [x] J3 最小反思：四选一确认；家长端不可见；AI 不能自动提交反思
- [x] J4 复习包：20→5–8 可解释选择；A4 黑白 PDF；无答案泄露；书写空间+短 ID+结果勾选框
- [x] J5 下周末回传：独立做对/使用提示/做错/未完成各自产生正确状态；失败与提示题再安排
- [x] J6 掌握与复发：3–7 天独立成功→暂时掌握；再确认→稳定掌握；同知识点/错因复发仍提示
- [x] J7 降级与错误：无 Key mock 可用；超时/非法 JSON 可重试或人工；重复/旋转/空文件有明确反馈
- [x] J8 权限：学生看详细反思；家长只看聚合；直接访问受限资源被拒绝（有测试）

## 工程 DoD

- [x] 旧代码未复用，项目从零初始化
- [x] PRD / PRODUCT_SPEC / MVP_USER_MANUAL 与实现一致
- [x] 单元、集成、E2E、typecheck、生产构建全部通过（无独立 lint 工具，strict tsc 覆盖）
- [x] 无 AI Key 的 mock 模式一键演示（`npm run demo`）
- [x] PDF 经过程序检查（pdf-lib 尺寸/页数 + pdfjs 文本层答案分离）；视觉检查列入试点前清单
- [x] 重复上传幂等；AI 失败有降级路径（超时→failed→重试）
- [x] 学生私人反思与家长视图隔离有自动化权限测试（sliceC + e2e J8）
- [x] README：环境要求、安装、启动、测试、demo、故障处理
- [x] 仓库无 secrets、真实未成年人数据、调试垃圾、未解释 TODO/FIXME
- [x] PRODUCT_VALIDATION_REPORT 如实记录证据与限制
- [x] REVIEW.md 逐项验收证据；HANDOFF.md 完整
- [x] 无 git commit/push/deploy；PR_DESCRIPTION.md 备妥
