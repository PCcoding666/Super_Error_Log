# 错题本回归学习任务：设计与交付约束

用户已确认截图审查方向，并在 2026-10-19 要求按 Apple 设计准则开发、拆 PR、提交。此次授权覆盖实施和提交 PR；不合并或部署。

## 目标
默认打开就能看到并辨认错题；学生可以找题、阅读自己的订正、重新练习、看到真实练习记录。章节是筛选条件，批量选择是显式模式。保留现有在线及纸上重做和延迟掌握规则。

## Apple HIG 对照（网页适配，不声称 Apple 认证）
参考入口：https://developer.apple.com/design/human-interface-guidelines/
- Layout / Hierarchy：https://developer.apple.com/design/human-interface-guidelines/layout 。首屏题目直接显示，低频筛选紧凑，桌面适当扩宽，手机单列。
- Buttons：https://developer.apple.com/design/human-interface-guidelines/buttons 。每个操作单一明确，网页交互目标至少 44×44 CSS px；不把原生 pt 与 CSS px 宣称等价。
- Typography：https://developer.apple.com/design/human-interface-guidelines/typography 。系统字体、相对字号；320px 与 200% 文字下不横向溢出。
- Accessibility：https://developer.apple.com/design/human-interface-guidelines/accessibility 。标签与控件关联，键盘焦点可见，状态不仅靠颜色，正常文字对比 4.5:1，大字 3:1，尊重 reduced motion/transparency。
- Color / Dark Mode：https://developer.apple.com/design/human-interface-guidelines/color 和 https://developer.apple.com/design/human-interface-guidelines/dark-mode 。复用已有语义色；照片不裁掉内容；浅深两色都验证。
- Navigation and search：https://developer.apple.com/design/human-interface-guidelines/searching 。清晰搜索范围、可清除筛选、空态有恢复操作；返回保留筛选和题目位置。
- Feedback：https://developer.apple.com/design/human-interface-guidelines/feedback 。已选题数与上限即时明确；错误不吞选择；服务器仍校验。

## 页面与数据约束
- TypeScript/Express/React SSR，不 hydration，不加框架或生产依赖。
- 不新增学习状态或伪造错因；展示已有学生确认反思和练习结果。
- 不改变学生隔离、AI校验、打印、照片上传、练习资格、最多8题、当天正确不算掌握的规则。
- 原题使用 scope=full&s=big，保留比例；短识别文本仅辅助。题图失败保留文字与原图入口。
- 常规浏览没有章节勾选框；显式选题模式可按题选择，章节全选只影响当前可选范围，可逐题取消。零题/超过8题/资格变化给出明确反馈，保留选择；无脚本仍可用原生表单完成。
- 详情以“重做这题/继续练习”为主要操作，OCR修正和移除为次要操作。答案与订正按需展开；已有学生错因及练习记录清楚呈现。
- 详情返回接受白名单规范化的站内 /s/items 查询与 item 锚点，拒绝外站或任意路径，不信任任意 returnTo。

## PR 边界
1. codex/notebook-reading -> main：阅读优先列表、搜索/年级/学科/章节/学习状态、选择模式、响应布局、返回上下文、相关测试与HIG对照。
2. codex/notebook-detail -> main：单题学习详情、已有学生反思、准确结果和提示使用记录、直接创建或续接现有单题练习、相关测试与HIG对照。
两分支最初各自从 `5d787e0` 创建并独立验证。最终把 `codex/notebook-reading`（`e88f1b5`）合入 `codex/notebook-detail`，在 PR2 分支保存已经解决冲突、可复现验证的组合实现；不会合并到主分支。

两份 PR 均以 `main` 为目标，遵循仓库约定。**先合并 [PR #34](https://github.com/PCcoding666/Super_Error_Log/pull/34)（阅读列表），再合并依赖它的 PR2（单题学习）**。PR2 暂时包含 PR1 的提交，使审查者无需自行解决未验证的冲突；单题改动可按 `codex/notebook-reading..codex/notebook-detail` 对比；最终横屏修正先提交在阅读分支 `944a516`，再合入详情分支，保留最新 PR #34 head 为祖先。共享列表/详情路由保留双方行为，返回地址统一使用 `safeNotebookReturn` / `notebookUrl` 的白名单规范化，仍保留题目锚点。完整组合验证在 PR2 分支执行。本次提交 PR 不授权合并 main 或部署。
