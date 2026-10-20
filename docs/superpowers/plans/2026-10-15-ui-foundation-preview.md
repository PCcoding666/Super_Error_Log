# 手机网页视觉基础与前后预览 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the two implementation tasks, then independent review. User has selected phased subagent execution. Do not ask again between tasks.

**Goal:** 完成已授权第一批 PR1：一致的 Apple-inspired 手机网页视觉基础，以及可视化的新旧对照。

**Architecture:** 冻结 `4317be8` 于独立 checkout。应用继续服务端渲染；视觉工作限定于共享资源和页面外壳。独立生成器从两个 checkout 的真实组件导出相同合成状态，托管静态交互演示和对照报告。

**Tech Stack:** TypeScript ESM, React 19 SSR, Express 5, Playwright, static HTML/CSS/JS, Sites private hosting.

**Spec:** `docs/superpowers/specs/2026-10-15-ui-foundation-preview-design.md`

## Global Constraints

- Node >=24；保留 form-driven SSR，无 hydration。
- 不修改学习状态、上传转换/幂等/重试、邀请码安全规则或 A4 打印内容。
- 不访问生产数据，不加入产品依赖，不提交真实照片/录音/邀请码/会话。
- 触摸目标至少 44×44 CSS px，正文默认 17 CSS px，颜色与动效具有可访问的降级方式。
- 预览必须标注合成数据和演示交互；静态演示不得被描述为实际服务器保存或真实 AI 识别。
- 每个任务只修改其拥有文件，共享的 package.json 变更由协调者合入。由协调者进行 Git 提交和全套检查，避免并行 Git 状态冲突。

## Review Focus

- 大字/窄屏下底栏遮住内容，或横向溢出：浏览器检查内容与操作可访问性。
- 深色/半透明层下文字对比度：使用实际 CSS token 计算，检查减少透明降级。
- 静态预览误触生产接口，或旧新版数据/组件不一致：离线资源和输出扫描，来源 manifest 和浏览器场景检查。
- 共用 CSS 影响 A4 纸张：现有打印 E2E/PDF 回归。
- 调整样式误损无 JS 表单、选择、语音或上传入口：现有全流程 E2E。

## Task 1: 公共视觉基础

**Files:** Own `src/web/assets.ts`, optional `src/web/styles.ts`, `src/web/views/layout.tsx`.

**Interfaces:** 保留 assets 的导出名、Page/NextBar/ButtonView 参数、所有 href/form/name/data-testid/data 属性；只更换表现。若提取 STYLES，assets.ts 继续重新导出同名常量。

- [ ] 阅读 spec 和现有三份文件；不改业务页面组织。
- [ ] 实现浅/深色 token、字阶、分组、按钮、表单和操作层；资源版本从 3 增加。
- [ ] 对基础可访问性与无 JS 表单不做破坏性变更；保持打印 CSS 结果。
- [ ] 运行 `npm run typecheck` 和相关既有测试；回报改动、观察、未验证项。

## Task 2: 真实页面导出的对照预览工具

**Files:** Own `scripts/ui-preview/` and `docs/ui-preview.md`. Any package.json script request goes to coordinator.

**Interfaces:** CLI accepts baseline source path, current source path, output directory; produces self-contained static `index.html`, version-specific page directories and assets, and `manifest.json` with baseline full SHA/current SHA or dirty marker, fixed fixture date, scenario paths. Exports each checkout's actual SSR components, not reconstructed UI. Use current repo dependencies without adding packages.

- [ ] 定义相同合成页面输入并分别动态加载两个来源组件。
- [ ] 导出样式/素材/页面，保留真实 DOM；为静态演示增加单独且明确标注的交互适配器，不打包生产 CLIENT_SCRIPT/Service Worker 或任何服务器凭证。
- [ ] 创建响应式对照报告，支持版本打开、场景选择、手机对照、合成演示输入/选择/跳转，所有不可用动作给出可理解的演示提示。
- [ ] 记录来源，验证输出资源和链接，提供本地运行命令；添加必要的生成器验证，避免镜像实现的测试。
- [ ] 回报生成与浏览器检查命令、交互范围、限制。

## Integration and delivery

- [ ] 协调者运行基线完整 verify 并保存结果。
- [ ] 协调者整合两个任务；独立 reviewer 审查 spec 合规、回归与预览真实性。
- [ ] 使用实际生成的新旧页面进行手机尺寸、深色、大字与减少动态检查，保存对照 PNG 与交互录屏。
- [ ] 运行 `SEL_AI_MODE=mock npm run verify`；修复失败后仅按必要范围重跑。
- [ ] 将合成对照输出复制到独立 Sites 静态源，owner-private 发布并确认终态 URL。
- [ ] 提交第一批改动和验证证据；给用户对照入口、图片/录屏、检查结果与限制。
