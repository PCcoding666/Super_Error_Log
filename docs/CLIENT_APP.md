# 学生端单页应用（client/）

2026-10-23 起，学生端界面改为 Ionic React 单页应用，放在 `client/`，和服务器一起打包。设计方向见本文档末尾；这里记录结构、接口与迁移状态。

## 为什么换

- 产品决定：这一轮做减法，只留「错题本 + 录入」两个东西；练习模块先「即将推出」，不再有底部标签栏。
- 体验目标：像 iOS 原生（Siri 对话列表那种一屏结构：大标题、分组列表 / 网格、选择模式、左滑删除、系统拍照菜单）。服务端渲染的表单页做不到左滑、底部弹层和页面推入推出；Ionic 的 iOS 模式是现成的，Capacitor 还留了以后打包成 App 的路。
- 代价：客户端层重写；上传代码从旧页面脚本搬过来（见下）；「关掉脚本也能用」不再是约束。

## 结构

| 位置 | 作用 |
| --- | --- |
| `client/src/main.tsx` | 入口，`setupIonicReact({ mode: 'ios' })`，全平台统一 iOS 外观 |
| `client/src/App.tsx` | 四个路由（相对 `/s`）：`/` 错题本、`/new` 录入态、`/q/:id` 题目详情、`/me` 设置 |
| `client/src/pages/*` | 四屏 |
| `client/src/lib/api.ts` | `/s/api` 的调用封装；非 JSON 响应（登录过期回登录页）时整页跳回 `/s/` |
| `client/src/lib/uploader.ts` | 拍照上传队列：浏览器端转 JPEG（最长边 4096、超 15 MB 降质量）、每张一个幂等 key、单并发、可重试；本批照片 id 存 sessionStorage |
| `client/src/components/StemText.tsx`、`src/text/stemBlocks.ts` | 题干渲染：只把 GFM 管道表格画成真表格（窄屏可横滑），其余文字原样保留换行，不做完整 Markdown（题号「10.」、负号、`x_1`、绝对值 `|x-1|` 会被误解析）。表头 + 分隔行才算表格，表体行格数须与表头一致，不符的行留作文字。识别提示词（`src/mobile/vision.ts`）要求模型把题干表格写成管道表格；写入 `text_excerpt` 时先去掉表格再截 80 字（`questionExcerpt`）。已识别的旧题目文字是压平的，需重新识别才有表格 |
| `client/src/components/Markdown.tsx`、`SolutionModal.tsx`、`FigureFrame.tsx` | 详情页「正确答案」：AI 解答用 `react-markdown` + GFM（列表、加粗、表格）+ `remark-math` 渲染，公式用 KaTeX 只输出 MathML（不要字体和样式表），按需加载（单独一个约 130 KB gzip 的包）。模型输出不可信：不渲染 HTML，链接只留文字、图片只留替代文字，拒绝 `\href` 等命令。交互图在 `sandbox="allow-scripts"` 的 iframe 里，页面由服务器单独下发（见下方 `/figure`） |
| `client/src/components/TextEditModal.tsx`、`VoiceButton.tsx`、`lib/voice.ts` | 改识别出的文字（题干、你写的、批改痕迹、参考答案、拍的答案）；备注的语音输入（浏览器录音 → 已有的 `POST /s/voice` 转写，最长 59 秒） |
| `client/src/components/CaptureInput.tsx` | 拍照和相册两个文件框，铺在按钮上由手指直接点开（不靠脚本 `click()`）。相册不带 `capture`、可多选；拍照带 `capture="environment"`。选好就进录入态 |
| `client/src/lib/chooserWatch.ts` · `components/ChooserBlockedToast.tsx` | 安卓「添加到桌面」的壳（小米浏览器等）不实现文件选择器：文件框有焦点、相册相机都不弹。点文件框后两秒内页面没被盖住也没 change，就提示换手机浏览器打开。服务端另对安卓的 manifest 发 `display: browser`（`src/web/staticAssets.ts`），以后桌面图标在浏览器标签里打开 |
| `src/web/apiTypes.ts` | 客户端与服务器共用的类型 |
| `src/web/api.ts` | JSON 接口，挂在 `/s/api`，和旧页面同一套鉴权、限流、学段门槛 |
| `src/web/clientApp.ts` | 找到 `dist/client`，下发页面壳与指纹资源 |

构建：`npm run build` 先 tsc 再 `vite build`（`client/vite.config.ts`，`base: /s/app/`），产物在 `dist/client/`，随发布包一起上线。开发时 `npm run client:watch` 持续构建，服务器每次请求都重新读 `index.html`，不用重启。类型检查 `npm run typecheck` 同时检查服务器和客户端。

下发：worker 在 `/s/`、`/s/new`、`/s/me`、`/s/q/:id` 返回页面壳（登录之后）；网关和 worker 共用的公开静态路由 `/s/app/assets/<file>` 返回指纹资源，长期缓存。

## 接口（/s/api）

| 方法 路径 | 说明 |
| --- | --- |
| GET `/notebook?subject&grade&chapter&tag&q` | 错题本：学科 / 学段 / 章节（一级标题）/ 知识点（二级标题）列表，按「今天 / 本周 / 更早」分组的题；`status` 仍可传但界面不再暴露练习状态 |
| GET `/items/:id` | 题目详情：题干、图片（上传的整页原图；点开同一张大图）、你写的（原作，订正和看不出是谁写的另外标出；同类几段合在一处）、批改痕迹、照片里资料自带的参考答案、AI 解答状态、学生备注、分类 |
| GET / POST `/items/:id/insight` `{retry?}` | AI 参考答案、Markdown 解题过程、交互图、根据学生原作推测的错因（`src/v2/insightService.ts`）。**后台排队生成**：题收进错题本后，等这个学生不在上传 / 识别 / 整理材料 / 准备打印时一道一道做；POST 只是把这道题排到最前（`retry: true` 是失败后学生点的重试），不马上调用模型。状态 `none` / `queued` / `generating` 都只显示「稍后就好」，`failed` 才给醒目的「重试」。按题目内容指纹缓存，修改识别结果、录入答案后重新排队；失败自动再试一次；每题每小时最多 6 次；只自动处理最近 `SEL_INSIGHT_BACKFILL_DAYS`（缺省 30）天录入的题，更早的打开时才排队。模型看题目照片（旧流程整题图、材料裁图）。没有学生原作就不推测错因（服务器强制） |
| GET `/items/:id/figure` | 交互图页面。立体几何：模型只给点坐标、棱、要强调的线和面，我们自己的脚本画成能拖动旋转的 3D 线框图；其他（函数图像、物理等）是模型写的自包含 HTML。这一页带自己的 CSP（只许内联脚本 / 样式，`default-src 'none'`、`form-action 'none'`、`frame-ancestors 'self'`、`sandbox allow-scripts`），网关不覆盖 worker 的这组头 |
| POST `/items/:id/text` `{revision,target,text}` | 改识别结果：`target` 是 `question` 或观察 ID；键盘直改（`directCorrection`，不调用模型），学生原作只能改回纸上写的（改动 ≤ 原文一半且 ≤ 20 字） |
| POST `/items/:id/answer-photos`（JPEG 正文）、GET `…/:photoId/image`、POST `…/:photoId` `{text}`、`…/:photoId/retry`、`…/:photoId/delete` | 拍照录入答案：照片缩到长边 2048 存库（每题最多 3 张），后台用模型找出这道题的答案转写（`answer_read` 阶段）；转写可改、没找到可以自己填、可重新识别、可删；转写结果作为解答的参考 |
| POST `/items/:id/remark` `{text}` | 学生自己记的备注（最多 1000 字，空串即删除）；只给本人看，日志只记题目 ID |
| POST `/items/discard` `{ids}` | 批量「不是错题」；逐条返回成功 / 失败 |
| POST `/items/:id/restore` | 撤销移除 |
| POST `/items/:id/category` `{grade,subject,chapter}` | 改分类 |
| GET `/settings` / POST `/settings/grade` | 学段、邀请码信息、版本；选学段（新账号的门槛也走它） |
| GET `/intake` | 录入态：每张照片的状态、已收录的题、等勾选的候选题；旧流程和材料流程同一形状 |
| POST `/intake/photos/:id/select` `{ids}` | 勾选加入（旧流程题 id；材料流程 `questionId:revision`） |
| POST `/intake/photos/:id/retry` / `/dismiss` | 重试识别 / 不要这张（后者仅旧流程） |

上传仍用现有端点：旧流程 `POST /s/capture`（JSON 模式）；材料流程 `/s/materials/session`、`/s/materials/captures`、`/s/materials/uploads`。

新账号没选学段时，所有接口回 `409 stage_required`，客户端显示选学段页，选好后重试。

## 迁移状态

- 已接管：错题本、录入、详情、设置四屏，以及新账号选学段。
- 仍由服务端页面提供（从单页应用链过去）：`/s/install` 添加到主屏幕说明、`/s/account` 我的邀请码、`/s/materials/questions/:id` 材料与批改来源、登录 / 注册 / 找回。
- 保留但没有入口：`/s/items`、`/s/photos`、`/s/capture`、`/s/practices`、`/s/choose`、`/s/practice/*`、`/s/why/*`、`/s/print/*`、`/s/record/*` 等旧页面及其测试。练习模块整体按下不表；相关路由和测试等产品决定后再删。
- 尚未搬过来：材料流程把待传照片存进 IndexedDB、关页后继续传（`src/web/uploadQueue.ts`）。现在关掉页面会丢还没传完的照片，页面上会说明。
- 端到端：`tests/e2e/app.spec.ts`（旧流程合成服务器）、`tests/e2e/appMaterials.spec.ts`（邀请码网关 + 材料流程）。

## 设计方向

参照 iOS Siri 对话列表与 Locally 的一屏结构：没有底部标签栏；右上角胶囊里是视图 / 筛选菜单（网格、列表、选择、章节、知识点；练习状态不再出现在界面上）和设置；左下角搜索；右下角是相册圆钮，它上面还有一颗拍照圆钮。空错题本和录入页另外写着「去拍照 / 从相册选择」。录入态一次上传算一批，按照片分段，找到的题默认已收录、左滑删掉不相关的，没有批改痕迹的页用圆形勾选框挑出做错的题。详情页（2026-10-24 按用户要求改版）是照片、题干（识别错了可以改），下面五块：「你写的」「批改痕迹」两行（点开看转写、逐段改；没有就写「没识别到」）；「章节与知识点」一张卡（章节加知识点标签，点按修改分类）；「正确答案」（AI 在后台解好的答案、Markdown 解题过程、几何 / 图像题的交互图，标「AI 解答，仅供参考」；照片里资料自带的答案、学生拍照录入的答案放在前面）；「错因（备注）」（AI 根据学生原作推测的错因，下面是学生自己的备注，可以语音输入，停笔 1 秒自动保存）。AI 推测不会写进备注，也不算学生的反思。

深色模式：Ionic 的 iOS 深色调色板写在 `:root.ios` 上，把 `--ion-item-background` 盖成纯黑，卡片和底色分不开。`theme.css` 的深色值同样写在 `:root.ios` 上、后加载，全应用按 `#1c1c1e` 卡片显示（2026-10-24 修）。

数据：新增 `item_insight`（每次模型调用一行，按内容指纹取用）、`item_answer_photo`、`item_note` 三张表（`src/db/schema.ts`，只新增表、不改旧表）。自动发布会因 `dist/db/` 变化而拒绝，需要人工发布，步骤见 [详情页解答验收](quality/2026-10-24-item-detail-insight.md)。新的模型阶段 `explain`、`answer_read`：百炼模式缺省 `qwen3.8-max`（`SEL_AI_MODEL_EXPLAIN` / `SEL_AI_MODEL_ANSWER_READ` 可改），启动守卫要求它们有模型。后台任务向父进程借模型名额时排在所有前台请求之后，名额满了前台还在等就让出（中止那次调用，稍后重排，不算失败）。
