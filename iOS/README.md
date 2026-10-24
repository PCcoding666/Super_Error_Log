# 超级错题本 · iPhone 学生端

SwiftUI 项目，最低 iOS 18。界面中文；单一「本周」主页，没有 Tab。
接口形状以 `docs/mobile-v2-api.md`（/v2）与 `docs/mobile-recognition-api.md`（/v1 上传与识别进度）为准。

## 登录与安装（2026-10-23 起）

- **邀请码登录**：主页「输入邀请码」→ 填老师/家长给的 12 位码（和手机网页版 `/s/` 同一个账号）→ 登录。
  App 走网关的原生接口 `/s/native`（见 `docs/ios-native-invitation-login.md`），之后的上传、识别进度、本周错题、练习、
  打印、录结果都落在该学生自己的服务器空间里，网页版能看到同一份。设置 ▸ 连接设置里可「退出登录」。
  旧的扫码配对保留在登录页底部作次要入口（没有邀请码的老部署、开发调试）。
- **装进自己的 iPhone（免费 Apple ID）**：`SEL_IOS_TEAM_ID=<你的 Team ID> zsh iOS/scripts/install-iphone.sh`，
  脚本自动签名、安装到数据线连着的 iPhone。免费签名 7 天失效（打开即闪退），再跑一遍即可；本机照片与服务器记录都在。
  也可以直接 Xcode 打开 `SuperErrorLog.xcodeproj`，Signing & Capabilities 选自己的 Team，选中真机点 Run。
  长期分支与发布节奏见 `docs/BRANCHES.md`「ios/main」。

## 学生的一周（当前流程）

1. **拍错题**：主页「拍这周的错题」拍照或从相册添加。原始字节留在本机，另存一份上传用 JPEG。
   首次上传前弹一次同意说明（点名目的地：广州云服务器 + 阿里云百炼）；同意后记住，
   之后新加的照片自动上传，不再问。没同意前照片只在本机。
2. **上传与识别**：每张照片一个任务，上传有真实字节进度；前台每 3 秒轮询识别进度，
   切后台停轮询不取消任务。上传成功拿到任务 ID 后立即 `POST /v2/photos/:jobId/register` 登记；
   登记失败不影响上传结果，下次刷新自动补登记。
3. **本周错题**：识别完成并登记后，题目卡片出现在「本周错题」。每张卡可「不是错题」
   （8 秒内可撤销）或「不对，改一下」（说一句生成修改建议 → 看改前改后 → 接受；
   或「自己动手改」键盘直改；修改带 revision 乐观并发，409 时刷新后重试）。
4. **选题**：「选这周要练的题」进推荐页，推荐默认全选、显示服务器给的推荐理由，
   「就练这些」建练习（1–8 道）。
5. **复盘（可选）**：练习卡「去复盘」→ 每题「复盘这道」→ AI 追问（最多两轮）→ 确认页
   （AI 建议预选并标注、「现在的把握」永不预选、没选把握不能提交）→ 学生自己点「提交复盘」。
6. **打印**：练习卡「打印练习纸」→ 服务器异步准备快照（手机轮询到 ready）→ 手机按快照
   原生排版生成 A4 PDF → 预览 → 系统分享/打印。快照只生成一次。
7. **录结果**：纸上做完后（隔 3–7 天）练习卡「录结果」，逐题选五选一完成情况与对错、
   写做题日期 → 提交 → 已记录区显示服务器给的那句话。当天做对不算掌握。
8. **看结果**：「看结果」页分「这次掌握的 / 做对了，过几天再验证 / 还要再练的」三组，
   另有校准句与下次确认日期。之后主页出现「选下一份要练的题」。

## 数据在哪

- **服务器是记录源**：错题、复盘、练习、结果都以服务器为准（/v2）。
- **本机只有**：照片原件与上传副本（Application Support，排除备份、按集合隔离）、
  Loop 只读缓存（`Loop/loop-cache.json`，离线时显示「上次保存的内容」并标注）、
  配对令牌（Keychain，按集合名隔离 scope）。旧版存档（v1 的 drafts/packs/realProblems）
  保持可解码，不再写入。
- 写操作必须联网，失败如实提示，不做本地排队。学生原话（追问回答、修改指令）不写日志。

## 构建与单元测试

仓库根目录执行，逐条单独跑：

```sh
swift test --package-path iOS
xcodebuild -project iOS/SuperErrorLog.xcodeproj -target SuperErrorLog -configuration Debug \
  -sdk iphonesimulator SYMROOT=build/Manual CODE_SIGNING_ALLOWED=NO -quiet build
```

Swift 包 `StudentCore`（`iOS/Package.swift`）只含纯逻辑与客户端：`Domain/`、
`RecognitionClient.swift`、`PairingStore.swift`、`StudyStore.swift`、`V2Client.swift`、
`LoopStore.swift`；视图文件全部在 `exclude` 里（不进包、只进 App target，Xcode 工程是同步目录）。
`swift test` 在 macOS 上跑（需 macOS 14+），用 `URLProtocol` 合成传输，不连真实服务。
云端 IP 入口的固定证书是 `StudentApp/Resources/cloud-ip-cert.pem`（部署时在服务器生成后拷入，见 `deploy/README.md` §9），
构建时自动打进 App；缺这个文件时 App 连 IP 入口一律拒绝，域名入口不受影响。`CloudIPEntryTests` 的真实握手用例
用 `/usr/bin/openssl` 临时生成证书、在进程内起只监听 127.0.0.1 的 TLS 服务（需 macOS 15+）。
注意：`SYMROOT=build/Manual` 等相对路径按**项目目录**（`iOS/`）解析。

## 界面回归测试（合成服务器，不连真实服务、不调用 AI）

`UITests/SyntheticRecognitionServer.swift` 是测试进程内的回环 HTTP 服务器：
模拟云端语义（配对兑换、health）与完整 /v2 闭环（登记、周视图、推荐、练习、打印
「轮询两次就绪」、回传、回报、追问、修改）。`LoopJourneyTests` 覆盖 J1 拍照进错题本、
J2 改与移出、J3 选题与复盘、J4 打印/录结果/看结果/下一份、J5 离线与重启；
`CloudConnectionJourneyTests` 覆盖连接状态机各分支。`LiveTourTests` 默认跳过（见下节）。

```sh
xcodebuild -project iOS/SuperErrorLog.xcodeproj -target StudentAppUITests -configuration Debug \
  -sdk iphonesimulator SYMROOT=build/Manual build CODE_SIGNING_ALLOWED=NO -quiet
zsh iOS/scripts/sign-simulator.sh   # 或等价：-target SuperErrorLog ... CODE_SIGNING_ALLOWED=YES \
                                    #   CODE_SIGN_IDENTITY=- CODE_SIGN_ENTITLEMENTS=scripts/Simulator.entitlements
xcodebuild test-without-building -xctestrun iOS/StudentJourney.xctestrun \
  -destination 'platform=iOS Simulator,id=9A990744-AF00-4275-8195-7336E94B7C06' \
  -resultBundlePath iOS/build/ui-<唯一名字>.xcresult -parallel-testing-enabled NO
```

- 每次重建后必须重跑签名步骤（Xcode 嵌入 simulated Keychain entitlements，ad-hoc 签名，
  不需要开发者身份）；否则 Keychain 报 -34018。
- 结果目录每次换新名字，保留失败证据。
- 模拟器相册里需要有照片（照片选择器测试用）；不要为重复测试重置或重复添加照片。
- 每条用例用独立 `-test-session <UUID>`（隔离的数据集合与 Keychain scope）+
  `-cloud-loopback http://127.0.0.1:<端口>`（仅 DEBUG、仅接受回环 http，Release 恒无效）。

## 「连真实服务」的探索走查（LiveTourTests）

默认跳过（没有环境变量即 skip）。跑法：

1. 本机以回环模式启动真实服务（`SEL_MOBILE_MODE=loopback`，独立数据目录与端口，自备配对口令）。
2. 模拟器里用 `-test-session <UUID>` 启动过一次 App，并把 `pairing-bootstrap.json`
   （`baseURL` + `token`）放进该集合的 `Library/Application Support/UITest-<大写 UUID>/`。
3. 给测试进程传环境变量 `TEST_RUNNER_SEL_TOUR_SESSION=<UUID>`、
   `TEST_RUNNER_SEL_TOUR_SHOTS=<截图目录>`（写入 xctestrun 的 TestingEnvironmentVariables
   或 scheme；`TEST_RUNNER_` 前缀会被剥掉再传给测试）。

这些用例会调用真实模型并在该服务数据里留下合成题目，**不要对着线上服务跑**。

## 已知限制

- 模拟器不能录音：按住说话（SFSpeechRecognizer）只能真机验证；语音不可用或被拒时只显示键盘。
- 真机签名用免费开发者证书 7 天到期（`scripts/install-iphone.sh` 重跑即可）；真机安装、相机实机验收不在模拟器验证范围内。
- 邀请码登录依赖服务器的 `/s/native`（2026-10-23 起的 `main`）；旧服务器只能用扫码配对。
- 删除应用会丢失本机照片与缓存；学习记录在服务器。
- 合成测试不证明真实模型质量；真实照片的识别正确性须对照原图逐项验收。
