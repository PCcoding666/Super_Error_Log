# ARCHITECTURE — 技术架构

版本：v1.0（2026-09-05）

## 1. 总览

单体 TypeScript Web 应用（本地优先）：

```
浏览器（手机/桌面）
   │ HTTP
   ▼
Express 5 服务（SSR：react-dom/server 渲染静态 HTML）
   ├── 页面路由（src/routes/pages.ts）
   ├── API 路由（src/routes/api.ts，家长/学生作用域隔离）
   ├── 领域层（src/domain/：状态机、评分、调度 —— 纯函数，单测）
   ├── 服务层（src/services/：批次处理、复习包、PDF）
   ├── AI 层（src/ai/：Provider 接口 + Mock + OpenAI-compatible）
   └── 持久层（src/db/：node:sqlite，WAL）
数据：data/app.db（SQLite）+ data/uploads/（上传资产，内容哈希寻址）
PDF：Playwright Chromium 打印专用 HTML → A4 PDF
```

## 2. 技术选型理由

| 选择 | 理由 |
|---|---|
| TypeScript 全栈 | 提示词建议；类型贯穿领域层与视图 |
| Express 5 + SSR（react-dom/server） | 表单型应用无需客户端水合；构建简单；易测试；维护成本低 |
| node:sqlite（DatabaseSync） | Node 26 内置，零原生依赖风险；单文件本地库 |
| Playwright | 本机已缓存 Chromium；同时承担 E2E 与 PDF 生成（CJK 字体由系统渲染，可靠） |
| sharp | 图片 EXIF 旋转归一化与校验（预编译二进制） |
| Vitest | 单元/集成测试，TS 原生 |

## 3. 关键设计

### 3.1 业务逻辑与 AI 解耦
- `src/ai/provider.ts` 定义 `AiProvider` 接口；领域/服务层只依赖接口。
- `MockAiProvider`：确定性输出。优先按 fixture 清单（文件名匹配）返回精确结果；否则用内容哈希派生稳定伪随机结果（含少量低置信度条目），保证任意图片都可演示。
- `OpenAiCompatibleProvider`：视觉模型 + JSON Schema 输出；超时/非法 JSON/网络错误分类上报。
- 选择规则：`SEL_AI_MODE=mock|openai`，未配置 Key 自动降级 mock（UI 显示当前模式）。

### 3.2 幂等与可恢复
- 上传资产以内容 SHA-256 寻址：同文件重复上传 → 标记 duplicate，不重复建条目。
- 提取结果以 `(asset_id, item_index)` 唯一约束：批次重试 INSERT OR IGNORE，不产生重复错题。
- 文件级失败隔离：单文件失败仅影响自身，批次进入 partial。

### 3.3 权限模型（MVP 单机单档案）
- 角色由本地 cookie `sel_role` 标识（student=拥有者默认，parent=聚合只读）。
- 中间件解析角色；parent 角色访问学生路由 → 403；`/parent` 仅查询聚合服务（物理上不含反思/图片字段）。
- 反思写路径要求 `actor=student`；AI 调用产生的建议写入单独的建议字段，永远不写反思表（API 层拒绝 source=ai 的反思提交）。

### 3.4 PDF 生成
- 打印专用 HTML 视图（独立 print CSS），Playwright `page.pdf({ format: 'A4', printBackground: false })`。
- 程序检查：pdf-lib 之外的轻量校验——页数、A4 尺寸（pdfjs 或头部解析）；答案区文本不出现在题目页（生成时数据层分离 + 文本抽取断言）。
- 实现：生成时使用分离的数据结构（题目页数据无答案字段），从源头杜绝泄露。

### 3.5 上传边界
- 格式：jpg/jpeg/png/webp/pdf；单文件 ≤ 15MB；非空校验。
- 图片用 sharp 按 EXIF 方向归一化；损坏文件 → 文件级失败。
- PDF 仅存储与页数记录；真实模式下按页转图属于后续增强（MVP 记录在限制中）。

### 3.6 日志与隐私
- 结构化事件日志（`.ai` 之外的 `data/events.log`），仅事件名+ID+时间；禁止反思文本、图片内容、secret。

## 4. 目录结构

```
src/
  server.ts            入口
  app.ts               express 装配
  config.ts            环境配置（不存 secret 本体）
  db/                  schema.ts、connection.ts
  domain/              stateMachine.ts、scoring.ts、scheduling.ts、types.ts
  ai/                  provider.ts、mockProvider.ts、openaiProvider.ts、errors.ts
  services/            batchService.ts、packetService.ts、pdfService.ts、trendService.ts、eventLog.ts
  routes/              pages.ts、api.ts、parent.ts、middleware.ts
  views/               SSR 组件（.tsx）
  fixtures/            generate.ts（合成 fixture 生成器）
  seed.ts              demo seed
public/                css/js 静态资源
tests/unit tests/integration tests/e2e
data/                  运行时数据（gitignore）
fixtures/              生成的合成测试资产（gitignore，可重新生成）
```

## 5. 质量命令

- 开发：`npm run dev`（http://localhost:3100）
- 完整质量：`npm run verify` = typecheck + 单测/集成 + 生产构建 + E2E
- demo：`npm run fixtures:generate && npm run seed && npm run dev`
