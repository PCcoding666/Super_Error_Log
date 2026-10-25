# 超级错题本 · iPhone 学生端

SwiftUI 项目，最低 iOS 18，界面中文。**和线上手机网页版 `/s/`（`client/`）是同一个产品**：同一个账号、同一份服务器记录，
四个屏幕一一对应——错题本（根）、录入、题目详情、设置。网页版改了流程，这里跟着改；对照表见下。

2026-10-25 起：旧的「本周 / 选题 / 复盘 / 打印 / 录结果」那套（`/v1` `/v2` 接口）已经整个删掉，不再有入口。
想看历史实现去 git 历史（`ios/main` 在这次改动之前的提交）。

## 和网页版的对应

| 网页版（`client/src`） | iOS（`StudentApp/`） | 说明 |
| --- | --- | --- |
| `pages/HomePage.tsx` | `NotebookUI/NotebookView.swift` + `Web/NotebookModel.swift` | 学科大标题（点开换学科）、网格 / 列表、学段·章节·知识点筛选、搜索、选择移除（可撤销） |
| `pages/IntakePage.tsx` | `NotebookUI/IntakeView.swift` + `Web/IntakeModel.swift` | 按照片分段、左滑删题、没批改痕迹的页勾出做错的题、失败重试 |
| `pages/ItemPage.tsx` | `NotebookUI/ItemView.swift` + `Web/ItemModel.swift` | 整页照片（可放大）、题干（含 GFM 表格）、你写的、改分类、移除 |
| `pages/SettingsPage.tsx` | `NotebookUI/SettingsView.swift` + `Web/SettingsModel.swift` | 学段、身份、邀请码快到期提醒、退出登录、版本 |
| `components/StageGate.tsx` | `NotebookUI/NotebookView.swift`（`StageGateView`） | 新账号先选初中 / 高中（服务器 409 `stage_required`） |
| `lib/uploader.ts` | `Web/UploadQueue.swift` + `Web/ImagePreparer.swift` | 最长边 4096 的 JPEG、15 MB 内逐级降质量、单并发、同一幂等 key 重试、旧流程 / 材料流程两套端点 |
| `lib/api.ts` | `Web/WebClient.swift` | 同一批 `/s/api/*` 接口（形状见 `src/web/apiTypes.ts` ↔ `Web/WebModels.swift`） |
| `src/text/stemBlocks.ts` | `Web/StemBlocks.swift` | 题干里只认 GFM 管道表格 |

网页版有而原生没有的：添加到主屏幕、「我的邀请码」页（在网页里管）、「查看材料来源」旧页面。
练习在网页版也是「即将推出」，这里同样只显示一行说明。

## 登录与网络

- **邀请码登录**：和网页同一个 12 位邀请码。App 走网关的 `POST /s/native/login` 换 Bearer 令牌（30 天，活跃自动续），
  存钥匙串；令牌失效（401）自动回登录页并提示重新输入。
- **读写错题本**：所有数据请求走 `/s/native/web/*`（网关替 App 带内部 cookie 转到该学生的 worker 的 `/s/*`），
  只放行单页应用用到的路径。契约见 `docs/ios-native-invitation-login.md`「/s/native/web」。
  这一入口随 `main` 部署，**服务器没部署它之前，新版 App 登得进但读不到错题本**。
- 图片（缩略图、裁图、整页照片）要带令牌，`ImageStore` 自己取并降采样缓存；`/s/img/item/…` 会 303 到真正的裁图，
  客户端只跟站内 `/s/` 路径，其他重定向一律不跟。
- 入口：域名 `study.pccoding666.com`（系统证书）或 IP 直连（App 内固定证书，`StudentApp/Resources/cloud-ip-cert.pem`，
  缺这个文件时 IP 入口一律拒绝，域名不受影响）。

## 装进自己的 iPhone（免费 Apple ID）

```sh
SEL_IOS_TEAM_ID=<你的 Team ID> zsh iOS/scripts/install-iphone.sh
```

脚本自动签名、安装到数据线连着的 iPhone。免费签名 7 天失效（打开即闪退），再跑一遍即可，数据都在服务器上。
也可以直接用 Xcode 打开 `SuperErrorLog.xcodeproj`，Signing & Capabilities 选自己的 Team，选中真机点 Run。
长期分支与发布节奏见 `docs/BRANCHES.md`「ios/main」：服务器改动先进 `main`，再合进 `ios/main`。

## 构建与单元测试

仓库根目录执行，逐条单独跑：

```sh
swift test --package-path iOS
xcodebuild -project iOS/SuperErrorLog.xcodeproj -target SuperErrorLog -configuration Debug \
  -sdk iphonesimulator SYMROOT=build/Manual CODE_SIGNING_ALLOWED=NO -quiet build
```

Swift 包 `StudentCore`（`iOS/Package.swift`）只含纯逻辑与客户端：`Domain/`、`Web/`、`RecognitionClient.swift`
（只剩邀请码登录 / 退出用）、`PairingStore.swift`；视图（`NotebookUI/`、`Theme.swift`、`SuperErrorLogApp.swift`）
在 `exclude` 里，只进 App target（Xcode 工程是同步目录，新文件自动进 target）。
`swift test` 在 macOS 上跑（需 macOS 14+），用 `URLProtocol` 合成传输和假接口，不连真实服务。
`CloudIPEntryTests` 的真实握手用例用 `/usr/bin/openssl` 临时生成证书、在进程内起只监听 127.0.0.1 的 TLS 服务（需 macOS 15+）。
注意：`SYMROOT=build/Manual` 等相对路径按**项目目录**（`iOS/`）解析。

## 模拟器走查（连本机开发网关，不碰线上数据）

`UITests/WebParityTourTests.swift` 从登录走到退出：登录 → 选学段 → 空错题本 → 录入（`-inject-photo` 代替系统相册选择器）
→ 勾候选题加入 → 错题本列表 / 网格 → 详情 → 设置 → 退出，每一屏截图。默认跳过（没有环境变量即 skip）。

1. 本机起网关：真实网关 + 真实 fork 的 worker + 合成识别（照 `tests/e2e/studentHostServer.ts`，固定端口，
   `SEL_E2E_MATERIAL_JOURNEY=1` 用材料流程的合成夹具），记下它打印的邀请码。
2. 给测试进程传环境变量（`TEST_RUNNER_` 前缀会被剥掉）：`TEST_RUNNER_SEL_WEB_BASE=http://127.0.0.1:<端口>`、
   `TEST_RUNNER_SEL_WEB_CODE=<邀请码>`、`TEST_RUNNER_SEL_WEB_PHOTO=<一张 JPEG 路径>`、`TEST_RUNNER_SEL_TOUR_SHOTS=<截图目录>`。
3. 钥匙串要 simulated Keychain entitlements，否则登录成功后保存凭据报错：

```sh
xcodebuild test -project iOS/SuperErrorLog.xcodeproj -scheme SuperErrorLog \
  -destination 'platform=iOS Simulator,id=<模拟器 UDID>' -only-testing:StudentAppUITests/WebParityTourTests \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- CODE_SIGN_ENTITLEMENTS=scripts/Simulator.entitlements
```

- 每次用没用过的邀请码（同一个学生会留着上次录入的题）；每条用例用独立 `-test-session <UUID>`
  （隔离的钥匙串 scope）+ `-cloud-loopback http://127.0.0.1:<端口>`（仅 DEBUG、仅接受回环 http，Release 恒无效）。
- SwiftUI 给容器设 `accessibilityIdentifier` 会盖掉所有子控件的标识：容器用 `.containerIdentifier(_:)`。

## 已知限制

- 真机签名用免费开发者证书 7 天到期（`scripts/install-iphone.sh` 重跑即可）；真机相机、相册选择器、蜂窝上传
  不在模拟器验证范围内（模拟器里相册 / 相机选择走系统界面，自动化够不到）。
- 删除应用会丢失本机缓存；学习记录在服务器。
- 上传暂不支持切到后台继续传（和网页版一样，传完才算；失败的照片留在队列里点「再试一次」）。
- `RecognitionClient` / `CloudPairing` 里还留着旧扫码配对、health、识别任务的客户端代码和测试（已无入口），
  后续可以整块删掉。
