# 2026-11-07 高保真端到端测试：真实照片 · 真实模型 · 生产入口

时间 2026-11-07 16:00–16:25（北京）。本地 macOS，分支 `codex/log-route-id-mask`（工作树里有未提交的 `src/web/trail.ts` 改动，未影响本次链路）。证据目录：[assets/hf-e2e-20261107/](assets/hf-e2e-20261107/)，可复现脚本在其 `harness/` 子目录。这是本地测试，不是 Actions、线上或真人手机验收。

## 结论

- **主链路通**：邀请码登录 → 选学段 → 拍照/相册（单页、多页托盘、相册多选）→ AI 找题 → 自动收录 / 手勾加入 → 错题本（按学科）→ 详情 → AI 错因与解答 → 改题干 → 备注自动保存 → 移除 / 撤销 → 设置 / 我的邀请码 / 添加到主屏幕 → 退出 → 同一邀请码重登。代理层共 613 个请求，0 个 4xx/5xx；网关日志 0 条 warn/error；所有响应都带 `x-sel-request-id`。
- **8 张照片 4 成功 4 失败，失败全是确定性的代码问题**（F1、F2），不是模型随机性，学生点「重试」结果相同。
- **真实教材页的识别质量不可用**（F3）：定位框太小，精读出来的是碎片，红笔批改没识别到，整页退化成「没有批改痕迹 · 勾出做错的题」，勾进错题本的题干是残句。
- **AI 解答有错且泄露推理独白**（F4）：数学第 14 题答案错，解题过程 5191 字里夹着「难道答案只有一个？」「等等，让我们重新」。化学、物理四道解答正确。

## 1. 环境

| 项 | 取值 |
| --- | --- |
| 服务 | `npm run build` 后的 `dist/main.js`，`SEL_MOBILE_MODE=cloud`、`SEL_STUDENT_HOST_ENABLED=1`、端口 3177、`SEL_MAX_LIVE_WORKERS=3`，数据在 `data/hf-e2e-20261107/`（gitignored） |
| 入口代理 | 自签名 HTTPS 反向代理 `https://127.0.0.1:3443`（`harness/tls-proxy.mjs`），转发 `X-Real-IP`。必须有它：云端装配把网关的 Origin 校验写死为 `https:`，直连 http 的 POST 会被当成跨站 |
| 模型 | 仓库 `.env` 的百炼**按量付费**密钥；`qwen3.8-27b`（material_extract / material_verify）、`qwen3.8-max`（explain）。没有用 Token Plan：本机 bl 的 `token-plan` 配置里存的是同一把按量密钥，在 Token Plan 端点 401 |
| 浏览器 | Playwright WebKit + `devices['iPhone 15']`（Safari 内核、390×844、触摸、`ignoreHTTPSErrors`），每一步一个子命令（`harness/run.mjs`），cookie 存 state.json |
| 学生 | `node dist/studentHost/admin-cli.js create`，初中；邀请码只在本机文件里，不进仓库 |

## 2. 素材

| # | 内容 | 来源 | 像素 / 浏览器转换后大小 | 上传方式 |
| --- | --- | --- | --- | --- |
| 1 | 九年级数学 p15 因式分解，蓝黑笔作答 + 红笔批改 | `iOS/StudentApp/Resources/SamplePhotos/IMG_5516.jpg`（真实 iPhone 照片） | 3024×4032，2.57 MB | 首页「从相册选择」→ 单页 |
| 2、3 | p16、p17 根与系数，红笔批改和大叉 | IMG_5517 / IMG_5518 | 3024×4032，2.6 MB 各 | 首页「从相册选择」→ 多页，托盘 2 张一起提交 |
| 4 | 高中立体几何打印卷，手写过程，无批改 | `.ai/legacy/preserved/POC/vlm_api_testing/temp_file/0436….JPG` | 1080×1440，459 KB | 录入页「从相册选择」→ 单页 |
| 5、6 | 初三物理练习册、初三化学测试卷（含 ✗ ✓ 和红笔订正） | `bl image generate --model wan2.7-image` | 1728×2368 PNG，转成 1.0–1.3 MB JPEG | 录入页相册多选 2 张 → 单页 |
| 7、8 | 同上两张，更清晰 | `qwen-image-3.0-pro`（用户点名的 `qwen-image-3-pro` 在百炼不存在） | 同上 | 同上 |

生成素材预览：[gen-wan2.7-physics.jpg](assets/hf-e2e-20261107/gen-wan2.7-physics.jpg)、[gen-qwen-image-3.0-pro-chemistry.jpg](assets/hf-e2e-20261107/gen-qwen-image-3.0-pro-chemistry.jpg) 等四张。wan2.7 的物理图右半页是乱文，qwen-image-3.0-pro 两张文字完全正确。

浏览器端把 1.7 MB 的 iPhone JPEG 重编码后变成 2.6 MB（长边 4096 不缩放，质量偏高），上传本身 88–260 ms。

## 3. 逐张结果

| # | 结果 | 识别耗时 | 模型阶段 | 学生看到的 |
| --- | --- | --- | --- | --- |
| 1 | 成功 | 659 s | 51（1 定位 + 25 候选 × 读 / 验） | 「没有批改痕迹 · 勾出做错的题」，6 个候选（10–15 题），摘录是碎片；勾 13、14 后 2 道进错题本 |
| 2 | **失败** | 1 次本地校验即失败 | locate-set | 「没整理成功 · 原图已保留，可以重新整理」+「重试」，重试同样失败 |
| 3 | **失败** | — | 无（随 2 失败：`set_page_missing`） | 同上 |
| 4 | **失败** | 40 s | locate 1 次 | 同上，重试同样失败 |
| 5 | 成功 | 440 s | 27 | 「没有批改痕迹」，3 个候选，第 3 题摘录混入右半页乱文；勾第 3 题后 1 道进错题本 |
| 6 | 成功 | 345 s | 19 | **「找到 2 道 · 1 道打了 √」**，第 1、3 题自动收录，打 ✓ 的第 2 题正确排除 |
| 7 | **失败** | 26 s | locate 1 次 | 同 4 |
| 8 | 成功 | 129 s | 21 | 文字干净但「没有批改痕迹」，勾第 1、3 题后 2 道进错题本 |

最终错题本：化学 4、数学 2、物理 1，全部「未分类 · 还没有知识点」。

## 4. 发现（按严重度）

### F1 两张真实照片的「多页」组必然失败：超出 10 万 token 预留

`src/ai/chatClient.ts:87` 的 `MAX_INPUT_TOKEN_RESERVATION = 100_000`，每张图预留 `ceil(w/16)·ceil(h/16) + 1024`。3024×4032 一张就是 48,652；`src/materials/provider.ts` 多页定位（`locate-set`）把每页都按 4096 长边喂进去，两页 97 k 加提示词就越界，抛 `unsupported`「模型输入超出保守预算」，`retryable:false`。第二页随之 `set_page_missing`。

对照实际计费：1080×1440 的图模型按 1532 个 image_tokens 计费，本地却预留 6120，约 4 倍。也就是预留公式远高于真实成本，把「一题跨两页」这个产品承诺的场景直接堵死。

建议：多页定位时把各页缩到 2048 长边（或按实际 token 估算预留）；`retryable:false` 的失败录入页不要再显示「重试」。

### F2 定位输出缺 `warnings` 字段就整张作废：8 张里 2 张，温度 0 下永久复现

照片 4、7 的 locate 调用模型返回了 `document` + `candidates` 但没有 `warnings` 键，`src/materials/provider.ts` 的 `inventory()` 用 `list(v.warnings)` 把 `undefined` 判成 `invalid_output`「材料提取结果未通过来源或结构校验」，不可重试。原始输出已重放并保存：[replay-locate-geometry-raw.json](assets/hf-e2e-20261107/replay-locate-geometry-raw.json)、[replay-locate-physics-qwen3pro-raw.json](assets/hf-e2e-20261107/replay-locate-physics-qwen3pro-raw.json)（`role` 是单元素数组，这个是允许的；唯一不过的就是缺 `warnings`）。

修复一行：`warnings: list(v.warnings ?? [])`。顺带建议把被拒的原始输出落盘（现在任何地方都没有存，只能靠重放还原）。

### F3 真实教材页：定位框过小 → 精读碎片 → 校验全失败 → 批改痕迹丢失

照片 1 的定位给了 25 个候选框，题干框高度几乎都是 0.02（约 80 px），而这页是倾斜拍的，行距本身就有 0.025。精读出来的文字是「B 则 3x+1=0或1.」「已知方程(x-2)(3x- 式)若菱形ABCD…」这样的串行残句；校验阶段 25 个片段里 22 个判 `failed` / `low`，并且在不确定项里**把正确位置和正确内容都写出来了**（「候选框选区域过小」「实际的学生作答内容位于 (0.28, 0.16)」「图片中完整句子为“则 3x+1=0或7.”」），但这些信息被丢掉。3 个 `teacher_mark` 候选全部 `failed`，于是一页红笔批改被判成「没有批改痕迹」，学生只能手勾；勾进去的题干就是残句（[82-detail-1-top.png](assets/hf-e2e-20261107/82-detail-1-top.png)），候选缩略图是窄条（[41-candidate-1-4.png](assets/hf-e2e-20261107/41-candidate-1-4.png)）。

建议：定位前做旋转 / 透视矫正并要求最小框高；把校验阶段的定位反馈回灌做第二轮定位；批改痕迹判定不要只依赖 `teacher_mark` 片段 `check=passed`。

### F4 AI 解答错误并泄露推理独白（数学第 14 题）

答案栏显示「k = 3 或 k = 13/4」，正确答案是 k = √5 或 √13（学生自己其实做对了）。解题过程 5191 字，后半段是模型自言自语：「难道答案只有一个？」「让我们重读题」「两个答案都应该对」「等等，让我们重新」——而答案栏和过程互相矛盾。截图 [84-detail-1-solution.png](assets/hf-e2e-20261107/84-detail-1-solution.png)，全文结尾 [insight-q14-solution-tail.txt](assets/hf-e2e-20261107/insight-q14-solution-tail.txt)。模型 `qwen3.8-max`，`enable_thinking=false`，耗时 60 s。

同题的「AI 推测错因」也站不住：第 13 题说「两道题都只写了一个根」，照片里两问都写了两个根（因为「你写的」被截断了）。

建议：对 explain 输出加结构约束和一致性检查（答案字段必须在过程里出现、长度上限、出现第一人称独白判 failed 重试）；错因推测只在学生原作片段 `check=passed` 时才给。

### F5 批改痕迹识别不稳定

同一份化学卷：wan2.7 版本识别出 ✗ / ✓ 并自动收录第 1、3 题；更清晰的 qwen-image-3.0-pro 版本却是「没有批改痕迹」。物理图上的大红叉和红笔订正也没被当成批改。

### F6 录入页把失败和仍在识别的照片折叠进「更早的 N 张」

每次换页面 / 换浏览器回来，sessionStorage 里的「本批」就没了，所有照片都进折叠组，顶部只剩「AI 正在找题」，3 张失败的看不到（[30-intake-with-failed.png](assets/hf-e2e-20261107/30-intake-with-failed.png)）。真实学生从微信切到 Safari 再回来就是这个状态。

### F7 其他

- 章节分类从未自动运行（`classification_task` 0 行），7 道题全是「未分类 / 还没有知识点」，错题本的章节、知识点筛选是空的。
- 候选详情把学生自己的手写当「批改痕迹」展示（照片 1 第 15 题）。
- 退出登录后 `/s/api/*` 返回 200 `text/html`（登录页）而不是 401 JSON；客户端按「非 JSON」整页回登录页，能用，只记录。
- `bl` 2.3.1 在 Node 26 带 `HTTP_PROXY` / `NODE_USE_ENV_PROXY=1` 时报 `UND_ERR_INVALID_ARG: invalid onError method`，去掉代理变量才能用；它的自动升级到 2.8.4 因 npm 镜像找不到 `bailian-cli-core@2.8.4` 失败。

## 5. 通过的部分

- 登录 303 → 选学段页只出现一次 → 首页；退出后再用同一邀请码登录不再问学段，错题本还在。
- 三种上传入口都能用：首页相册 → 单页；首页相册 → 多页（托盘显示「已拍 2 张」→ 完成，两张共用一个拍摄批次）；录入页相册多选两张 → 两次 `/s/materials/uploads`。
- 化学、物理 5 道：题干逐字正确（连生成图里重复的「C. 海水 C. 矿泉水」都如实保留，AI 解答还指出了标号印错）；错因推测切题；答案 B / A / 12000 m 正确；物理那道在题干被截断的情况下从老师订正反推出 t = 600 s。
- 改题干后 `insight` 立刻变 `queued` 并重新生成；备注停笔后「已保存」，刷新和接口都能读回；「不是错题，移除」弹层 → 移除 → 错题本少一道 → `restore` 接口恢复。
- 设置页：身份「学生」、服务「已连接」、版本 0.1.1；「我的邀请码」页显示到期时间和重新生成入口；添加到主屏幕说明页可开。
- 资源：网关 40 MB RSS、学生 worker 65 MB、代理 32 MB；一个学生全程一个 worker 进程。
- 接口延迟（代理观测，p95）：`/s/api/intake` 17 ms（224 次轮询）、`/s/api/notebook` 35 ms、`/s/api/items/:id` 71 ms、候选裁图 509 ms、整图 70 ms。

## 6. 模型用量（全部按量付费）

| 阶段 | 次数 | 平均 | 最长 | 输入 tokens | 输出 tokens |
| --- | --- | --- | --- | --- | --- |
| material_extract（定位 + 精读） | 64 | 10.7 s | 67.6 s（整页定位） | 56,000 | 13,985 |
| material_verify | 57 | 10.0 s | 35.2 s | 171,423 | 6,247 |
| explain | 8 | 19.1 s | 60.0 s | 17,413 | 6,774 |
| 合计 | 129 | — | 模型总时长 1,409 s | 244,836 | 27,006 |

一张 25 个候选的真实教材页要 51 次调用、11 分钟；同一学生最多 3 张并行、全局 2 路模型并发，8 张照片 23 分钟全部结束。

## 7. 复现

```sh
npm run build
# 服务：harness/run-server.sh（数据目录 data/hf-e2e-20261107，按量密钥来自 .env）
# 代理：node harness/tls-proxy.mjs（证书自签：openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1）
SEL_STUDENT_HOST_DIR=$PWD/data/hf-e2e-20261107/student-host node dist/studentHost/admin-cli.js create
# 驱动（放在带 package.json {"type":"module"} 和 node_modules 软链的目录里）：
node run.mjs login <邀请码> 初中
node run.mjs upload single <photo.jpg>
node run.mjs upload multi <p1.jpg> <p2.jpg>
node run.mjs intake --wait=600 ; node run.mjs pick <张号> 1,3 ; node run.mjs candidate <张号> <序号>
node run.mjs notebook --subject=化学 ; node run.mjs detail 0 --subject=化学
node run.mjs remark 0 --subject=化学 "…" ; node run.mjs edit-stem 0 --subject=化学 "…" ; node run.mjs discard 1 --subject=化学 --restore
node run.mjs settings --logout
# 看被拒的原始模型输出：npx tsx harness/replay-locate.mjs <原图> <assetId> <sourceHash> out.json
```

## 8. 修复与复验（同日 17:30，分支 `codex/material-locate-budget`）

用户确认后在本地修了 F1、F2，改动在 `src/ai/chatClient.ts`、`src/materials/provider.ts`，回归测试在 `tests/integration/materialProvider.test.ts`（新增 3 条）：

- **F2**：`inventory()` / 精读 / 校验里的 `warnings`、`uncertainties` 缺省或为 null 时按空数组处理（`optionalList`），出现但不是数组仍判 `invalid_output`。
- **F1**：多页定位前把各页按同一长边一起缩到预算内（`fitSetPagesToBudget`，上限 2048 px、下限 1024 px，逐页处理以控内存），只缩定位那一份，精读仍裁全尺寸原页；这一次调用的超时按页数放宽（最多 3 倍）。`reserveImageTokens` 从 `checkInput` 抽出来共用，预留公式不变。
  过了预算之后真实照片又暴露出多页路径的四个问题，一并修了：
  1. 模型把多页结果回成裸数组（或只回当前页一个对象）而不是 `{pages:[…]}`；校验阶段也会把对象裹成一元素裸数组。现在 `unwrap` 把一元素裸数组当作「镜像请求」解开，`inventorySet` 接受三种形状；多元素数组仍判 `invalid_output`。
  2. 候选的 `page` 填的是页序（1、2）而 `document.page` 是印刷页码（16），原校验当成串页拒绝。`inventory()` 在页序等于本页位置时把它归一成印刷页码，其他不一致仍拒绝。
  3. 提示词要求模型「只为当前页输出 candidates」，代码却指望 lead 的一次定位带回全组每一页，于是其他页被写成零片段的「成功」（p17 单独重试后显示「没有新增错题」）。现在 lead 对每一页各做一次定位（每次都带全组图、标出当前页，阶段键 `locate-set:<assetId>`），每页得到自己的候选。
  4. 多页定位的结果原来是 `Map`，写进任务检查点的 JSON 后回放成 `{}`，重试 / 重启续做时会丢掉定位结果；改成按 assetId 的普通对象。
  5. 第二页定位返回的框 `x 0.18 + width 0.83 = 1.01`，右边超出 0.01，`validateBox` 整页拒绝（重试三次都一样）。现在模型输出里超出不到 0.02 的框贴边裁回（取四位小数），超得多仍拒绝。
  6. 被拒的原始模型输出以前哪里都不存，只能靠重放猜；现在 `invalid_output` 把正文前 4000 字符记在那一阶段的错误里（`detail`，存学生自己的任务记录，不进日志、不回给页面）。第 5 条就是靠它在一次重试里定位到的。

复验方法：`npm run build` 后用同一数据目录重启本地服务，在录入页点原来失败的那几张的「重试」。

| 照片 | 修复前 | 修复后 |
| --- | --- | --- |
| 4 高中几何（打印卷） | `invalid_output`，重试同样失败 | 定位通过，17 个阶段成功，「没有批改痕迹」给出 1 个候选「第 4 题 如图1，在平行四边形ABCD中…」（AB 误读成 AE） |
| 7 物理（qwen-image-3.0-pro） | `invalid_output` | 「找到 1 道 · 1 道打了 √」：打 ✗ 的第 3 题自动收录、题干逐字正确，打 ✓ 的第 4 题正确排除 |
| 2+3 数学 p16/p17 多页组 | 本地预算检查直接拒绝（`unsupported`） | 第一版（4096 → 3840 px）过了预算检查但两页定位调用超过 90 s 超时；第二版（2048 px + 放宽超时）定位在 67 s 内返回，却因裸数组 / 页序被结构校验拒绝（重放原始输出见 `assets/…/replay-locate-set-raw.json`：只回了当前页、34 个候选、框高 0.03–0.14，比单页 4096 时的 0.02 合理）；第三版（每页各一次定位 + 裸数组 / 页序 / 框容差 / 检查点对象）：**两页都成功**，lead 任务 167 个阶段 0 失败；p16 得到 10 个候选（第 1–8 题，题干完整，如「(武汉元调改编)若关于x的方程x²+bx-12=0有一个根是x=2…」）、p17 得到 6 个候选（第 9–14 题），进入「勾出做错的题」（[113-intake-multipage-fixed.png](assets/hf-e2e-20261107/113-intake-multipage-fixed.png)）。红笔批改仍全部判 failed（F3 / F5 未动），p16 的「易错点睛」被定位成两个重复候选。两页从重试到结束约 10 分钟，共 205 次模型调用 |

复验时还看到一个新问题 **F8**：worker 处理 12 MP 照片期间 RSS 到 558–614 MiB，超过单进程准入阈值（本机 512 MiB；生产小机按 `SEL_SERVICE_MEMORY_MIB=1024`、3 个 worker 算是 192 MiB），期间任何新上传 / 重试都回 503 `service_paused`，页面提示「处理服务已暂停，请稍后重试」。这不是修复引入的（修复前的多页路径同样要解码两张 12 MP 图），但说明生产的阈值和真实照片的内存峰值不匹配，值得单独看。

修复阶段共跑了 4 轮真实重试、211 次模型调用（4 次是第一版的 90 s 超时），全程按量付费。

门禁：`npm run typecheck` 通过；`SEL_AI_MODE=mock npm run verify` 第一次 vitest 有 2 个与本改动无关的失败（`materialJobs` 退避时序断言、`opsScripts` 恢复演练 60 s 超时，当时真实模型流水线和 e2e 同机并行），单独重跑这两个文件 42 条全过；最终版本完整 vitest 1703 过 / 2 跳过，`opsScripts` 恢复演练在同机跑真实流水线时又超时一次、单独跑 17 条全过；材料相关 e2e 子集（appMaterials / materialIntake / materialJourney / studentHost / materialCapture）49 条全过；`npm run test:e2e` 129 过 / 5 跳过 / 2 失败，两条失败与本改动无关且在本机一直存在：`app.spec` 立体图拖动的视口高度断言、`captureModeMaterials.spec` 往 `/opt/cursor/artifacts` 写截图时 `EACCES`（写死的 Cursor 云环境路径）。
