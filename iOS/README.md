# 超级错题本 · iPhone 学生端

独立 SwiftUI 项目，最低 iOS 18。应用导航、复盘选项、状态与 PDF 标签为中文；原题文字、旧英文选项内部值和学生自由笔记不改写。示例题与真实确认题分开呈现，示例不计入真实学习进度。

## 当前流程

1. 本周添加照片：原始导入字节留在本机；后台生成一次 JPEG 副本。导入本身不发请求。每批最多选择 10 张，按显示顺序确认并提交；多次导入的其余照片仍留在本机，可再选下一批。每批上传前显示所选照片、实际数量、百炼处理说明；不同意则不上传。
2. 连接设置（双模式）：回环模式填写 `http://127.0.0.1:3101` 等本机地址及配对口令（仅适用这台 Mac 的 iPhone 模拟器）；云端模式（Task 5）用相机扫描管理员在 Mac 服务端生成的配对二维码，兑换一次性会话为 30 天设备令牌。二维码只接受固定云域名 `https://study.pccoding666.com` 的 HTTPS 地址；任意服务器、http、带凭据/端口/路径的 URL 一律拒绝，重定向一律禁止。设备令牌与 deviceId 存 Keychain（本设备）；云端每批提交前强制重新 health 检查（不是仅 30 秒缓存），服务返回的 serviceId 必须与配对一致。连接状态行显示在「本周」主屏与连接设置页：未配对（扫码配对）、已配对待检查（自动首次检查）、检查中、可以上传（开始上传）、服务繁忙（稍后再试）、连接失败（重试连接）、授权失效（重新配对，清空凭据后回扫码）、版本不兼容（重新配对）。上传确认页云端模式显示「照片将上传到你的广州云服务器，再由阿里云百炼处理」。UI 测试注入：DEBUG 构建可用 `-cloud-loopback http://127.0.0.1:<端口>` 启动参数把云模式指向本机合成服务器（仅接受回环 http URL，Release 构建该覆盖恒为 nil，不能绕过固定云域名约束）；首次启动且无配对时自动向合成服务器兑换。
3. 上传：在发送前持久化 UUID 幂等键，重复尝试读取同一份已经保存的 JPEG。每张照片独立生成异步任务，上传期间照片卡片显示真实字节进度（百分比与进度条）。前台短轮询，后台停止轮询而不取消服务任务。已同意的上传即使在非前台返回，也不会重新启动轮询，回到前台后才恢复。照片卡片按语义着色：灰=仅本机，蓝=上传/识别中，橙=待你确认，绿=已确认，红=失败可重试——“看到橙色就是你的活”。
4. 查看候选：全部题目或“批改标记 / 订正痕迹”筛选，印刷题干与原作、订正分开。完整本机原图始终可缩放查看；没有通过核对的裁剪仅作为明确标注的次要检查入口。`completed` 不代表已确认。
5. 确认：必须打开可读完整原图，必要图示经后台完整解码可读取，再明确勾选逐项比较。图示到达时可用状态自动刷新；损坏图示不会启用确认，可“重新读取题目图示”。损坏下载或被替换的旧缓存字节保存在同一私有集合的 `CorruptMedia/`，不覆盖丢弃证据。`needs_check` 不能直接确认；可保留疑问或暂不处理。可重试的失败项只重试该项。仅已确认且满足独立核对条件的快照进入复盘。
6. 复盘：“查看题目”包含已确认快照的完整题干、可读本机图示及分别标注的原作／订正等来源记录，未提交或已保存后都可离线查看。缺少图示时明确提示不可用，保留原图入口，不用其他图片代替。四个问题均由学生选择，前三问选中即自动进入下一问（短暂停顿让勾选可见，可点返回修改），最后一问明确点「保存复盘」提交；展开的题目可收起，选择练习题仍需另行操作。
7. 练习包：保存创建时的题目快照；印刷题干可跨页，必要图示必须已保存、可读取。PDF 不读取原始整页、原作过程或订正记录。可预览、系统分享或打印。
8. “读取本机已有识别任务”仅通过配对 API 读取已有任务与来源图片，不产生识别调用、不授予上传同意。按任务 ID 去重，拒绝较旧快照。已保存结果与复盘离线可读。

这实现了客户端流程；合成 HTTP/UI 测试不证明真实模型质量。真实照片题目覆盖、转录与图示正确性须由原图逐项验收，不能以接口成功或 UI 测试通过替代。

服务会公开原始候选位置（不是已验证裁图），同题号出现多处时要核对具体位置；旧记录没有位置则如实提示。裁剪查看器的正文和辅助阅读标签都标为裁剪，不再称作完整原图。示例指导语只做中文显示映射，不改写保存的原文或真实证据。

结构／认证／权限／模型配置失败不自动循环请求。服务公开 `recoverable` 时，可在修复后明确选择“重新识别这道题”或“重新识别这张照片”，阅读可能产生新模型请求的说明后再次确认；只继续该项保存的下一阶段，保留已完成步骤、其他题目和历史记录。旧任务不会因启动或读取而自动恢复。内存中的旧记录可接受同版本新增候选位置／恢复策略字段，但不会因此接受题干、状态或确认内容的同版本改写。

## 构建和模拟器

本机 Xcode 26.6 的 SDK 为 26.5，已有模拟器 runtime 为 26.3/18.6。以下使用直接 target 构建，不修改全局 Xcode 选择或安装 runtime：

```sh
cd /Users/chengpeng/MyProject/Super_Error_Log/iOS
env DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test
env DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project SuperErrorLog.xcodeproj -target StudentAppUITests -configuration Debug \
  -sdk iphonesimulator SYMROOT=build/Manual build CODE_SIGNING_ALLOWED=NO -quiet
zsh scripts/sign-simulator.sh
```

最后一步由 Xcode 在模拟器二进制内嵌入 simulated Keychain entitlements，并使用本机 ad-hoc 签名；不需要开发者身份或设备签名团队。直接对 app 使用带 iOS entitlements 的 `codesign` 会被 macOS 拒绝；仅无 entitlement 的未签名构建又会导致 Keychain `-34018`。每次重建后都应再运行这个 helper。

```sh
env DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test-without-building \
  -xctestrun StudentJourney.xctestrun \
  -destination 'platform=iOS Simulator,id=9A990744-AF00-4275-8195-7336E94B7C06' \
  -resultBundlePath build/ui-UNIQUE-RUN.xcresult -parallel-testing-enabled NO
```

每次使用新的结果目录，保留失败证据。UI 测试每次创建独立 UUID 本机集合；`SyntheticRecognitionServer` 仅在测试进程内开启随机回环端口，用合成响应测试解码、确认、离线复盘和 PDF，不连接真实服务/模型。照片选择器测试需要现有照片库；不要为重复测试重置或重复添加照片。

Swift 包含真实 Store/持久化/客户端的合成 URLProtocol 回归，测试运行需 macOS 14+（Observation）；iPhone 最低版本仍为 iOS 18。只有相机导入与 UIKit PDF 入口不在 Mac 测试包内，仍由模拟器流程验证。

日常启动：`zsh scripts/run-simulator.sh <已有设备 UUID>`。准备私有示例图：`zsh scripts/prepare-examples.sh /path/to/run-UdBWjj`；这些文件不提交。未提供示例图时，原图入口明确显示缺失，不替换图片。不要分发包含私有示例图的构建。

## 隔离 QA 配对

正常使用通过“连接设置”填写口令。仅 Debug 支持测试准备：用 `-test-session <UUID>` 启动后，QA 操作者可以将 `pairing-bootstrap.json` 放入 app 数据容器的 `Library/Application Support/UITest-<大写 UUID>/`。文件结构是 `baseURL` 字符串与 `token` 字符串；只能放本机配对口令，不放模型密钥。

应用读取并验证该文件，写入按同一 UUID 隔离的 Keychain 项，成功后删除 bootstrap 文件。普通集合继续使用原 Keychain 项。启动参数只传 UUID，不能传口令；测试日志与截图中也不能出现真实口令。准备该文件的人应使用私有文件权限且避免打印内容。

## 数据边界

数据在 Application Support 内，排除系统备份。照片同时保留原始导入字节与一次生成的上传 JPEG；从本机已有任务读取的来源则是服务保存的 JPEG。修改采用磁盘原子保存后再更新界面；无法识别或损坏的数据保留并阻止写入。版本 1 的示例复盘与练习包可迁移，原笔记和内部选项值保留。

删除应用会丢失本机集合，尚无云恢复、导入/导出学习历史或照片删除界面。物理设备签名、相机授权实机测试、App Store 分发不在当前模拟器验证范围内。纸上练习结果是学生自述，不是 AI 评分，也不代表已掌握。
