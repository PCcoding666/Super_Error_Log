# HIG 首页重设计验收 · 2026-10-16

实现提交：`d830523b3a7f05a82ffee39be5640e312c5a7071`，分支 `codex/hig-home-redesign`。对照基线为上一轮被否定的 `e27982793f9953ff788582ad63825fa8ea17d4a1`，原始 `4317be8` 快照继续保留。

## 实际使用的 Skill

[Apple Design Skill](https://github.com/dickwu/apple-design-skill/blob/914b6a377c22755597e4405e54911b996de822d7/SKILL.md)，固定提交 `914b6a377c22755597e4405e54911b996de822d7`。实施者与独立审查者读取其中的 HIG 参考；本轮使用 accessibility、layout、typography、color、designing-for-ios、tab-bars、sheets、buttons、materials、motion 和 cross-platform。逐项映射、颜色参数及网页适配边界见 [设计记录](../plans/2026-10-16-hig-home-redesign.md)。

这次修改了页面结构与交互：单一当前任务、内联操作、三个真实根导航、本周安排面板、按需安装说明。范围是首页、共享外壳和两个根页面导航，不代表应用全部流程已完成重新设计；不声称原生 HIG 认证。

## 验证

- 最终 `npm run verify` 退出0：typecheck、build、63个 Vitest 文件通过，742项通过／5项跳过；Playwright 24项通过／1项跳过。
- Linux 环境跳过 macOS WebKit 真实 HEIC 解码项；其余上传转换、失败恢复、超时、重试、邀请、隐私、完整周末A/B、无脚本学习流程全部通过。
- 新增实际服务器 E2E：三根导航及当前位置、面板焦点循环、Esc／明确关闭／遮罩／长拖关闭与焦点返回、短拖取消、320px深色200%文字、无脚本 details 回退。
- 静态导出14场景×320／390／430px×浅深色×100%／200%文字，共168个页面检查，没有文档横向溢出或页面脚本错误。此项不代替所有视觉与读屏检查。
- 独立审查实际查看改前、改后、深色、面板及大字截图，复测手势和键盘。发现的短拖误关闭与预览练习入口缺失已修复，无遗留 Critical／High 或待修 Medium 项。
- 指定角色色对按 WCAG 公式计算，结果见设计记录；没有把原生 pt 当作 CSS px，没有把浏览器缩放称为 Dynamic Type。
- 原 A4 打印规则保持一致，新导航和面板打印时隐藏；未改照片转换脚本与学习领域规则。

## 可复现预览

```sh
npm run ui:preview:check
npm run ui:preview -- --before /workspace/Super_Error_Log-ui-v1 --after /workspace/Super_Error_Log --out /workspace/Super_Error_Log-ui-preview/dist
python3 -m http.server 3188 --bind 127.0.0.1 --directory /workspace/Super_Error_Log-ui-preview/dist
npm run ui:preview:capture -- --url http://127.0.0.1:3188 --out /workspace/Super_Error_Log-ui-preview/dist/evidence
```

生成器记录两端干净源提交与样式哈希；输出14个同数据场景、30张页面截图（含新版浅深色面板）、2张并排对照和2段交互录屏。三根导航和面板已在最终导出候选物实际点击复核。演示不连接 AI、不上传、不建立真实登录，不替代真机体验。

更新现有私有预览站：[前后对照](https://super-error-log-ui-review.speedyvenus3.chatgpt.site)。站点只发布合成静态产物，保持原所有者访问范围；实际学生应用未部署。预览可单独打开新版、切换浅深色、尺寸、200%文字，并进入截图图集。

## 提交 PR 前与最新 main 整合

上文记录首轮独立设计与发布到预览站的快照。用户随后授权提 PR 并合并；远端此时已通过 PR #12–#16 统一到 `main`，并加入更多功能。本次先合入最新基线 `e255fb14812dcb02ad9a57e0dae6a686ce173f22`，PR 目标为 `main`，旧设计快照保留在本地 `codex/hig-reviewed-preview`。

- 保留内容指纹 CSS/JS 路径、独立客户端脚本、defer 加载、批量上传与逐张失败重试、语音会话隔离、中文分词与原 A4 输出。
- 保留所有学习阶段的“＋补充错题”入口及准确的“这一份练习纸已准备好”文案；辅助入口采用次级样式。
- 当前任务与周安排同属一个局部更新区域。面板打开时暂缓替换，关闭后刷新；新面板重新增强，运行时属性不触发无意义更新，关闭后不留孤立弹层。新任务通过现有读屏播报区域告知。
- 补充浏览器脚本生命周期回归：相同内容保留 DOM；打开面板时延后更新；关闭后正确更新主任务和面板、播报新任务，弹层只有一个。
- 手势测试原先在入场过渡仍移动约32px时采集坐标，后续拖动错过抓手。改为等待实际动画完成并重新测量位置；短拖取消、长拖关闭阈值保持。
- 纸面样式快照误收录了三行与纸面无关的屏幕颜色／断行注释片段，现仅去掉这些非 CSS 片段，所有纸面规则与 HTML 字节断言保留，真实 A4 PDF 输出测试通过。
- 200% 页面缩放检查区分固定根导航和内联任务操作，内联主按钮滚动到可见后仍必须完整呈现。独立复核195×422无横向溢出、根导航高66px；320px／200%文字的面板控件正常。

本次相对最新 `main` 不修改 CI／自动发布配置、账号注册表、照片上传实现或学习领域规则。合并后的发布按现有主线自动发布流程执行，以实际 Actions 结果为准。

整合验证：`SEL_AI_MODE=mock npm run verify` 退出0，68个 Vitest 文件、805项通过／5项环境跳过；Playwright 37项通过／6项条件跳过。读屏播报补充后，生命周期专项、typecheck、预览脚本类型检查再次通过；集成静态导出14场景成功。独立代码及窄屏视觉复核无待修问题。GitHub检查和合并状态以本 PR 的实际记录为准。
