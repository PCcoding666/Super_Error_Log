# 设计注释约定

供人类贡献者和 Coding Agent 编写、修改和审查源代码注释时使用。当前产品与开发约束从 [AGENTS.md](../../AGENTS.md) 进入。

## 什么时候写

注释记录理解当前代码所需的非显然约束，说明为什么这样处理，以及违反约束会造成什么后果。优先覆盖这些情况。

- 判断或执行顺序影响状态迁移、缓存、并发或资源释放。
- 重试需要保留幂等身份，异步结果需要匹配数据版本。
- 规则依赖另一个模块、外部协议、单位或数据布局。
- 兼容处理、临时 workaround 或经验阈值有具体依据。

紧邻受约束的语句写一到三行，语言沿用周围代码。较长的整体设计理由放在模块说明或当前设计文档中，注释引用其位置。命名和类型能够完整表达的事实交给代码表达。

## 署名与来源

新增或实质性改写的非显然设计说明采用 `NOTE(<author>)`。人类作者使用自己的 GitHub 用户名，Agent 使用实际工具身份，例如 `chatgpt`、`codex` 或 `claude`。署名记录这段说明的撰写者，人工批准与责任承接以 PR 审查记录为准。

格式示例中的 `<author>` 在实际提交时替换为真实身份。

```ts
// NOTE(<author>): 已暂时掌握的题在不足三天时独立答对，应保留暂时掌握状态，提前处理通用天数判断会使它降级。
// See tests/unit/stateMachine.test.ts 的确认轮不足 3 天用例。
```

- 原因依赖跨文件行为、回归事件或外部限制时，附上已经核实的测试路径、当前设计文档、issue 或上游链接。源码里的仓库内路径从根目录写起，优先用函数名或测试名称定位。
- 普通 API 字段说明、许可证、工具指令等沿用原有格式。涉及非显然约束的 docstring 在对应段落使用同样的署名方式。
- 已有注释随相关代码改动核查。补充来源时保留已有署名，实质性重写时记录重写者，并保留仍有效的约束及来源。
- `TODO` 写明具体工作，并关联可核实的负责人或 issue。Agent 需要后续处理的工作通过 issue 留下跟踪入口。
- 临时 workaround 写清触发原因和移除条件，例如依赖修复版本及相应回归验证。尚未验证的推测在 PR 中标明，并给出核查方式。

## 本仓库的三个实例

以下是当前实现与已有测试的阅读入口。修改这些区域时，先核对对应实现与断言。

### 上传重试

`Uploader.retry()` 在照片准备、上传或退避等待期间阻止第二个并发 POST。实际重试复用这张照片的上传 ID，保留服务器识别重复请求所需的身份。只看一次请求是否成功，容易遗漏退避期间再次点击的行为。

实现见 [uploader.ts](../../client/src/lib/uploader.ts) 的 `retry()`、`process()` 和 `armBackoff()`。证据见 [ionicUploadRetry.test.ts](../../tests/unit/ionicUploadRetry.test.ts) 的 `waits out busy and retries the same upload id without a second in-flight POST` 与 `does not open another POST while the first is still uploading`。

### 静态资源缓存

`sendClientAsset()` 先取得实际可发送的字节，再设置长缓存和编码响应头。先设置响应头会让文件读取失败时的错误响应携带一年缓存或错误编码。

实现见 [clientApp.ts](../../src/web/clientApp.ts) 的 `sendClientAsset()`。证据见 [clientAssetEncodingRegression.test.ts](../../tests/integration/clientAssetEncodingRegression.test.ts) 中压缩件不可读、原文件也不可读的回归用例。该权限用例在 root 用户下跳过，报告结果时保留这项覆盖限制。

### 掌握状态迁移

`statusAfterAttempt()` 对已暂时掌握的题先处理确认轮，再处理普通的短间隔作答。暂时掌握的题在不足三天时独立答对，保留暂时掌握状态。提前抽出通用的天数判断会让它进入普通的 `attempted` 分支。

实现见 [stateMachine.ts](../../src/domain/stateMachine.ts) 的 `statusAfterAttempt()`。证据见 [stateMachine.test.ts](../../tests/unit/stateMachine.test.ts) 的确认轮间隔 0、1、2 天及刚好 3 天用例。

## 随改动维护与审查

修改相关行为时，同步核对注释、引用依据和对应断言。约束仍有效时保留原因，约束改变时记录新的决定并更新相应说明。清理注释前，确认其中的跨文件事实和边界条件仍有明确出处。

审查涉及设计注释的改动时，检查以下三点。

1. Agent 能从注释说明一种会破坏当前约束的具体修改。
2. 署名对应实际撰写者，来源确实支持所描述的行为。
3. 引用的测试或设计仍适用于当前实现，运行与跳过情况如实记录在 PR。

这份约定通过 [Agent 入口](../../AGENTS.md) 和 [PR 模板](../../.github/PULL_REQUEST_TEMPLATE.md) 进入开发与审查流程。注释含义和署名真实性由审查核对。
