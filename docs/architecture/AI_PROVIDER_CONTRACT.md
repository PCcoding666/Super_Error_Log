# AI PROVIDER CONTRACT — AI 服务契约

版本：v1.0（2026-09-05）

## 原则

- 业务逻辑只依赖 `AiProvider` 接口；mock 与真实服务可互换。
- 所有 AI 输出都是「建议 + 置信度」，永不直接写入学生反思。
- 无 API Key 时自动使用 deterministic mock，全部功能与测试可运行。
- 日志与 `ai_run` 审计只记录元数据，不记录图片内容、反思文本、API Key。

## 配置

| 环境变量 | 说明 |
|---|---|
| `SEL_AI_MODE` | `mock`（默认）/ `openai` |
| `SEL_AI_BASE_URL` | OpenAI-compatible endpoint（如 `https://api.example.com/v1`） |
| `SEL_AI_API_KEY` | Key（仅从环境读取，不显示、不记录、不持久化到库） |
| `SEL_AI_MODEL` | 模型名（真实模式） |
| `SEL_AI_TIMEOUT_MS` | 默认 30000 |

模式解析：`SEL_AI_MODE=openai` 但缺少 BASE_URL/KEY/MODEL → 自动降级 mock 并在 UI 与启动日志提示（不打印 Key）。

## 接口（src/ai/provider.ts）

```ts
interface AiProvider {
  readonly name: string;
  extractItems(input: ExtractInput): Promise<ExtractResult>;
  suggestFields(input: SuggestInput): Promise<FieldSuggestion>;
  matchReturnSheet(input: MatchInput): Promise<MatchResult>;
}
```

### extractItems — 从资产切分错题
输入：资产 ID、mime、存储路径、（mock）fixture 清单。
输出：
```ts
{
  items: Array<{
    itemIndex: number;
    textExcerpt: string;           // 题目文本摘要
    subject?: '数学'|'物理'|'化学';
    chapter?: string;
    knowledgeTags: string[];
    questionType?: string;          // 选择/填空/计算/证明/实验...
    hasTeacherNote: boolean;
    hasAnswer: boolean;
    confidence: number;             // 0..1 整体
    fieldConfidence: Record<string, number>; // 字段级
  }>
}
```
低置信度规则：整体 < 0.8 或任一关键字段 < 0.6 → `needs_correction=1`。

### suggestFields — 字段与复习价值建议
输出：学科/知识点/题型/可能错因/复习价值的建议值 + 置信度。仅展示，不入库为事实。

### matchReturnSheet — 完成页匹配
输入：`imagePath`（服务器上的真实文件路径，视觉模型读取用）+ `originalName`（客户端原始文件名，启发式/mock 匹配用）+ 候选短 ID 列表。输出：`{ shortId, confidence }`；< 0.8 → 需人工确认。

## 错误分类（AiError.kind）

`timeout` | `invalid_json` | `rate_limited` | `provider_error` | `unsupported`

服务层策略：timeout/provider_error 可重试（最多 2 次，指数退避）；invalid_json 重试 1 次后转人工；全部失败 → 文件/条目标记「识别失败」，UI 提供重试与手动录入，不阻塞批次。

## Mock 行为（deterministic）

1. 若资产文件名命中 fixture 清单（`fixtures/manifest.json`）→ 返回清单中的精确结果（用于 E2E 断言 20 道确定题目）。
2. 否则用内容哈希派生稳定伪随机结果：1–3 道题/文件，学科轮换，约 1/5 条目低置信度，输出对同一输入永远一致。
3. mock 也会按注入开关模拟 `timeout` / `invalid_json`（测试用，env `SEL_MOCK_FAULT`）。
