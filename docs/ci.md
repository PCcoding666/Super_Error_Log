# 持续集成（GitHub Actions）

工作流文件：`.github/workflows/ci.yml`。每个 PR、以及每次推送到 `codex/ai-error-review-mvp` 或 `main`，都会自动跑下面两个 job。同一个 PR（或分支）有新提交时，旧的运行会被自动取消。

**CI 只验证，不部署。** 部署仍然是手动的，步骤见 `deploy/README.md`；这里没有任何部署步骤，也没有任何密钥。

## 两个 job

| job | 运行环境 | 跑什么 | 预计耗时 |
| --- | --- | --- | --- |
| `server` | `ubuntu-24.04`，Node 24 | `npm ci` → `npm run typecheck` → `npm run build` → `npx playwright install --with-deps chromium` → `npm test`（Vitest）→ `npm run test:e2e`（Playwright） | 约 6–10 分钟 |
| `ios-unit` | `macos-26`，Xcode 26.6 | `swift test --package-path iOS` | 约 3–6 分钟 |

两个 job 并行，互不依赖。耗时是估计值（本机实测整套 `server` 流程约 3 分钟、`swift test` 含首次编译约 35 秒；GitHub 的标准 runner 核数少、启动也要时间，所以按 2–3 倍估）。跑过几次之后以 Actions 页面上的实际耗时为准，并改掉这一栏。

### server

- 等价于 `npm run verify`（typecheck、build、test、test:e2e），拆成独立步骤，红了一眼就知道是哪一步。
- 全程 `SEL_AI_MODE=mock`。不需要、也不读取任何 AI 密钥，不会发出真实模型请求。测试里出现的 key 都是合成的假值，请求都打到本机的假服务；在禁止一切对外网络的沙箱里跑 Vitest，668 个用例照样全过。
- **Chromium 必须在 Vitest 之前装好。** `tests/globalSetup.ts` 在干净的 checkout 里会调用 `generateFixtures()`（用 Chromium 渲染合成试卷），生成 A4 PDF 的 `src/services/pdfService.ts` 也用 Chromium。把安装步骤挪到 `npm test` 之后，`npm test` 会在 globalSetup 直接报 `Executable doesn't exist`。
- `npm ci` 前设了 `NPM_CONFIG_REPLACE_REGISTRY_HOST=always`：`package-lock.json` 里全部下载地址都指向 `registry.npmmirror.com`（国内镜像），这样 CI 改从 `registry.npmjs.org` 下载。锁文件里的 sha512 校验照常执行，装到的内容不变。哪天锁文件重新生成、地址变成官方源，这一行可以删。
- E2E 失败时，`playwright-report/`（HTML 报告）和 `test-results/`（含 trace）会作为 artifact `playwright-failure` 上传，保留 14 天。E2E 命令多带了 `--reporter=list,html --trace=retain-on-failure`，只影响产物，不影响通过与否。
- E2E 由 `playwright.config.ts` 自己起两个服务（3199，以及 3196/3197），数据放在 `data-e2e/` 和系统临时目录，不碰 `data/`。
- Linux 上有 5 个用例按设计被跳过：3 个依赖 macOS `sips` 的 HEIC 用例，2 个需要本机 Caddy（`SEL_CADDY_BIN`）的用例。

### ios-unit

- 只跑 `StudentCore` 包的单元测试，共 426 个。它们用 `URLProtocol` 合成传输，不连真实服务。`CloudPairingTests` 里写着生产域名 `study.pccoding666.com`，但请求被 `URLProtocol` 拦截，没有出网；在禁止一切对外网络的沙箱里跑，426 个照样全过，所以不需要跳过任何用例。
- `CloudIPEntryTests` 的真实 TLS 握手用例要 macOS 15+，`macos-26` 满足。证书身份只导入进程内存，不碰钥匙串。
- Xcode 固定为 `/Applications/Xcode_26.6.app`（`macos-26` 镜像的默认版本；`iOS/VERIFICATION.md` 记录的验证版本也是 26.6）。镜像移除这个版本时这个 job 会明确报错，改 `ci.yml` 里的 `DEVELOPER_DIR` 即可。
- runner 标签固定为 `ubuntu-24.04` 和 `macos-26`，没用 `*-latest`，避免 GitHub 切换默认镜像时 CI 悄悄变红。要升级时手动改。

## 没有覆盖的

- **iOS 界面回归测试**（`iOS/UITests`：`LoopJourneyTests`、`CloudConnectionJourneyTests`）。它们要模拟器、ad-hoc 签名步骤，整套约 9 分钟以上，见 `iOS/README.md`「界面回归测试」。要加就另起一个 job，不要塞进 `ios-unit`。
- **iOS App target 的构建**（`xcodebuild ... -target SuperErrorLog`）。目前只测 Swift 包，视图文件不在包里，所以视图层的编译错误 CI 看不到。
- **真实模型调用**。一律 mock；真实识别质量只能靠真实照片对照原图验收，CI 不证明。`LiveTourTests` 默认跳过。
- **真实 Caddy 集成**（`caddyIpEntry.test.ts` 的真实 Caddy 部分）和 **真机/相机/语音**。
- **部署**。不自动部署；合并到哪个分支都不会触发部署。

## 费用提示

仓库是私有的，Actions 分钟数计入账户额度，macOS runner 按 10 倍计。`ios-unit` 每跑一次大约消耗 30–60 个计费分钟，具体以账户 Billing 页面为准。取消旧运行（`concurrency`）已经能省掉一部分；还嫌多的话，可以让 `ios-unit` 只在 `iOS/**` 有改动时运行。

## 本地复现

```sh
npm ci
npm run typecheck && npm run build
npx playwright install --with-deps chromium   # 必须在 npm test 之前
SEL_AI_MODE=mock npm test
SEL_AI_MODE=mock npm run test:e2e              # 3199/3196/3197 端口要空闲
swift test --package-path iOS
```

同一台机器上不要同时在两个 worktree 里跑 E2E，端口会冲突（服务会报 `Process from config.webServer exited early`）。CI 里每个 job 是独立机器，不会遇到。
