# 手机网页视觉基础：第一批交付

## 查看结果

- [可操作的新旧对照](https://super-error-log-ui-review.speedyvenus3.chatgpt.site)
- [截图与交互录屏](https://super-error-log-ui-review.speedyvenus3.chatgpt.site/evidence/index.html)
- [单独查看旧版](https://super-error-log-ui-review.speedyvenus3.chatgpt.site/before/today.html?theme=light)
- [单独查看新版](https://super-error-log-ui-review.speedyvenus3.chatgpt.site/after/today.html?theme=light)

电脑并排显示；手机用「当前版本」切换，画面按可用宽度等比缩放。可切换 13 个场景、浅深色、手机尺寸、200% 文字与减少动态。预览采用 owner-private Sites 托管，可能需要使用当前 ChatGPT 账号登录。

这是各自版本真实 SSR 页面导出的静态合成数据演示。原生输入、选题计数、页面演示跳转、标签页设置和本机图片预览可用；不会连接 AI、上传、录音、打印或保存到服务器。产品真实行为由下述测试另行验证。现有学生生产站点未在本次发布。

## 改动

公共配色从暖纸色调整为冷中性分组底色；统一文字层级、间距、内容面、按钮和输入控件。补充浅深色、焦点、减少动态、减少透明及强制颜色模式。导航符号改为可访问的 SVG，保留文字名称。资源版本由 3 增至 4。

保留原有表单驱动 SSR、所有动作与数据属性、客户端脚本和 A4 打印 CSS。首页内容重排、局部识别刷新及半屏操作等留在后续 PR2–6。

增加 `ui:preview`、`ui:preview:check`、`ui:preview:capture`，可以从两个 checkout 重复导出同一组合成状态并生成证据。使用说明见 [ui-preview.md](../ui-preview.md)。

## 来源与发布

| 项目 | 值 |
| --- | --- |
| 应用工作分支 | `codex/ui-foundation-preview` |
| 旧版快照 | `4317be8dbacb54784034850dc1d9c5b785802176`，导出时工作区干净 |
| 新版预览来源 | `87f77a0b7183c3f456a648326148d7cec5aa4544`，导出时工作区干净 |
| 公共视觉提交 | `e92e563` |
| 固定合成日期 | `2026-10-17T02:00:00.000Z` |
| Sites 项目 | `appgprj_6ad0baee7bec81919158e064f231a34d` |
| 预览静态源提交 | `4bf44540979c1346976998daf97a6fb0bbd3caac` |
| 发布终态 | `succeeded`，2026-10-15 11:50 UTC |
| 发布 ID | `appgdep_6ad0be01d88c8191b5ddad52805146aa` |

Sites 的独立本地静态源位于 `/workspace/sites/sel-ui-review`；只包含合成导出与证据，不包含私有应用源码或凭证。当前环境没有 Sites skill 的源工作流 helper，使用原生 Sites 创建/凭证/私有发布工具，加 stdin 隐藏输入的 Git 推送及对应提交的 tar 产包完成相同的来源约束。短期凭证未写入文件或 Git 配置。

## 验证

| 检查 | 旧版 | 新版 |
| --- | --- | --- |
| `SEL_AI_MODE=mock npm run verify` | 退出 0 | 退出 0 |
| TypeScript / build | 通过 | 通过 |
| Vitest | 63 文件；742 通过、5 跳过 | 同基线 |
| Playwright | 22 通过、1 跳过 | 同基线 |

现有 E2E 覆盖上传兼容性/失败重试、邀请码、周末 A/B 闭环、语音替身、无 JavaScript 和 A4 PDF。Linux 没有执行 macOS WebKit HEIC 用例；不能把这些结果表述为真人录音、手机相机或实际打印验收。

另外完成：

- 预览工具独立 TypeScript 检查，演示/报告脚本与捕获脚本语法检查，静态资源和链接校验。
- 新版真实页面共 18 个主题/路由/宽度/文字组合：390px、320px、100%/200% 文字；无横向溢出，导航与底部按钮触摸区域不小于 44×44 CSS px。
- 62 个实际 token 对比组合通过：正文/说明/语义色最低浅色 4.62:1、深色 5.25:1；输入边界最低浅色 3.06:1、深色 4.33:1。
- 减少动态：动画为 none、transition 为 0s；减少透明：底栏为实色且无 backdrop filter。
- 独立审查批准公共视觉和最终工具；所有 26 个合成导出页面可载入，无页面错误，无外部或非 GET 请求。
- 验证演示登录、选题计数、追问跳转、设置刷新/版本隔离、未支持动作提示、iframe 返回对照。修复手机裁切后，320/390/430/1024px 报告均按比例展示且不改变内部视口；切换显示版本保留输入。
- 最终证据：26 张页面 PNG、2 张浅深色并排图、2 段 WebM 交互录屏；均记录干净来源快照。

首次新版完整检查发现一项旧测试仍固定期待原青绿色 `theme_color`；按新中性状态栏约定更新为 `#F2F3F7` 后全量通过。PWA 的 standalone、scope、start_url、图标与缓存隐私断言继续保留。

## 执行决定与限制

- 使用当前任务目录的新功能分支，另留 detached 旧版 worktree，隔离旧版且共享同版本依赖；需要调整时可按提交回退。
- 托管版本是明确标注的静态演示，因为现有 Express/node:sqlite 进程不能直接运行于 Sites Workers；未来若要远程测试真实后端，应另建 staging，不将静态演示当作后端验收。
- 按对话中已确认的方向与“开始第一批”执行，未重复要求用户批准同一工作；设计调整集中在第一批。
- 新 PWA 颜色是有意的视觉约定，因此更新原精确颜色测试，不删除行为断言。
- GitHub CLI 请求 `https://api.github.com/user` 返回 `Forbidden`，当前环境无法创建 GitHub PR。代码已提交到独立分支；没有声称已推送应用分支或创建 PR。
