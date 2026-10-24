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
| GET `/items/:id` | 题目详情：题干、图片（上传的整页原图；点开同一张大图）、你写的等笔迹、分类 |
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

参照 iOS Siri 对话列表与 Locally 的一屏结构：没有底部标签栏；右上角胶囊里是视图 / 筛选菜单（网格、列表、选择、章节、知识点；练习状态不再出现在界面上）和设置；左下角搜索；右下角是相册圆钮，它上面还有一颗拍照圆钮。空错题本和录入页另外写着「去拍照 / 从相册选择」。录入态一次上传算一批，按照片分段，找到的题默认已收录、左滑删掉不相关的，没有批改痕迹的页用圆形勾选框挑出做错的题。详情页只有照片、题干、你写的、章节、知识点（AI 识别的二级标题，只读），修改分类时可以从现有章节里选也可以自己填；底部留给以后的「错因教练」对话（学生自己说错在哪，AI 只追问、给台阶，不直接给答案）。
