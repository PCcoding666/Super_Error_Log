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
