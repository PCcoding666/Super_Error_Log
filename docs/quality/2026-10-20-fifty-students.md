# 五十个学生空间：懒启动、全局限流和 SQLite 小修

## 交付范围

仍是一个学生一个进程、一个目录、一个 SQLite。没有把学生并进同一个进程或同一张库。

- 注册上限沿用自助注册那一处：`SEL_MAX_STUDENTS` 缺省 100，在注册表打开时读取。这里不再另写一套上限。
- 父进程启动时不再为每个已注册学生拉起 worker。第一次请求才 fork。空闲 `SEL_WORKER_IDLE_MS`（缺省 12 分钟）后退出。正在转发的请求、排队或在跑的识别、等待重试、以及正在准备的打印，都不会被清掉。磁盘上没做完的任务下次启动继续。
- 同时存活的 worker 缺省最多 8 个（`SEL_MAX_LIVE_WORKERS`，0 表示不限制）。超出时先请最久没用、且当前没有请求的 worker 退出。都在忙则这次返回 503，一分钟后再试，不杀正在干活的进程。
- 视觉模型调用和 sharp 等重图片处理各有一把父进程信号量（缺省各 2）。学生自己的进程里仍然串行处理图片。纯文字追问不占视觉名额。
- 移动端单次模型超时缺省从 30 分钟改为 90 秒（`SEL_MOBILE_AI_TIMEOUT_MS`）。同题同阶段仍是最多 3 次调用。
- 单进程 RSS 准入不再固定 768MiB。按服务预算估算，可用 `SEL_RSS_ADMISSION_MIB` 覆盖。这是暂停接收新任务的应用层门槛，不是 cgroup 上限。
- `app.db` 增加 `busy_timeout = 5000`。`ai-usage.db` 使用 WAL。`error_diagnosis(item_id)` 和 `review_packet_item(item_id)` 用 `CREATE INDEX IF NOT EXISTS` 补索引，重复执行不会再建一次。管理后台的调用合计在 SQL 里算，明细最多带 2000 条；超过时页面会说明合计仍是全部。

## 验证记录

在 Node 24 上、`SEL_AI_MODE=mock`、合成数据：

- `npm run typecheck` 通过。
- `npm run build` 通过。
- `python3 -m unittest discover -s tests/deploy -p 'test_*.py'`：14 项通过。没有改发布脚本。
- Vitest：先跑全量时，学生网关审查夹具的假 worker 还没有 `retain`/`release`，7 项失败；补上这两个空操作后，该文件 24 项通过。同一轮全量里其余 982 项通过、5 项按条件跳过。失败只出在这个夹具上。
- Playwright：61 项通过，6 项按条件跳过（macOS HEIC、未开启的质量证据采集）。

## 发布状态

当前尚未发布。不要把本文件或本地测试当成线上版本。

这次同时改了 `src/db/` 和 `src/studentHost/registry.ts`。发布程序比较 `dist/db/` 和 `dist/studentHost/registry.js`，会以 `Database migration code changed; manual release required` 拒绝自动发布。上限就读在 registry 里，索引就加在 schema 里，不能为了躲过检查把它们挪走。不要改 `deploy/ci/sel-ci-deploy.py` 的迁移指纹，也不要加绕过开关。

数据库变更是加性的：两条 `CREATE INDEX IF NOT EXISTS`，以及打开库时设置 `busy_timeout` / `journal_mode=WAL`。没有删表、没有改旧列、没有重写学生数据。

## 人工发布前要在现网做的事

现网机器是 2 核 / 1.8 GB，systemd 239 / cgroup v1。单元文件的新默认值是 4 核 / 8 GB 的推荐档（`MemoryMax=4G`、`CPUQuota=300%`）。自动发布只备份现有单元，不会安装新单元。在这台小机上，重启前必须同时做两件事：

1. 安装 `deploy/systemd/super-error-log.service.d/small-box.conf`，让 cgroup 仍是 `MemoryMax=1G`、`MemoryLimit=1G`、`CPUQuota=150%`。不要把 4G 直接套到 1.8 GB 的机器上。
2. 在 `/etc/super-error-log/env` 写上小机档：`SEL_SERVICE_MEMORY_MIB=1024`、`SEL_MAX_LIVE_WORKERS=3`、`SEL_GLOBAL_AI_CONCURRENCY=1`、`SEL_GLOBAL_IMAGE_CONCURRENCY=1`。`SEL_MAX_STUDENTS` 保持缺省 100 即可，因为没人打开的学生不占进程。

只装 drop-in、不改环境，worker 会按 4G 预算估算自己的准入阈值。只改环境、把单元换成 4G，cgroup 上限会高于物理内存。

换到 4 核 / 8 GB 的机器时，用单元文件默认值，环境可以不写这些变量（缺省就是推荐档）。

## 具备管理员入口后的检查顺序

1. 确认 PR 的 CI、审查和将部署的提交一致。按已有发布流程看旧服务是否健康，识别和打印是否空闲。
2. 停服务后做一致性备份，包含数据库和 WAL、学生空间、照片和配置。不要把备份放进仓库。
3. 先在旧库副本上确认：打开 `app.db` 后 `PRAGMA busy_timeout` 为 5000；`PRAGMA index_list` 能看到 `idx_error_diagnosis_item` 和 `idx_review_packet_item_item`；把建索引语句再执行一遍，索引数量不变。下一次写入 `ai-usage.db` 后 `PRAGMA journal_mode` 为 `wal`。只核对这些，不输出学生内容。
4. 装好与机器匹配的 cgroup 和环境，再按既有受控流程部署。学生入口、设置、拍照应仍可用。已注册学生在重启后不会被立刻全部拉起，要等本人打开。
5. 核对内核读回：小机 `memory.limit_in_bytes` 为 1073741824、`cpu.cfs_quota_us` 为 150000；推荐档机器则是 4294967296 和 300000。记录实际线上提交和版本后再向用户汇报。代码回退不自动恢复数据库。

在完成上述人工发布之前，不把这个容量说成已经在线上。
