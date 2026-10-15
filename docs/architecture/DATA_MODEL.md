# DATA MODEL — 数据模型

版本：v1.0（2026-09-05） 存储：SQLite（node:sqlite），文件资产存 `data/uploads/`

## 实体与字段

### student_profile（单档案）
`id TEXT PK, nickname TEXT, grade TEXT DEFAULT '初三', subjects TEXT(JSON), weekend_pref TEXT, created_at TEXT`

### guardian_view_policy
`student_id TEXT PK FK, mode TEXT DEFAULT 'aggregate_only', show_subject_trend INT, show_completion INT, show_mastery_trend INT, show_reflections INT DEFAULT 0, show_item_detail INT DEFAULT 0`

### source_batch（上传批次）
`id TEXT PK, student_id FK, status TEXT(processing|needs_attention|partial|done|failed), total_files INT, done_files INT, failed_files INT, created_at TEXT`

### source_asset（单个上传文件）
`id TEXT PK, batch_id FK, filename TEXT, mime TEXT, size INT, content_hash TEXT, status TEXT(queued|processing|done|failed|duplicate|unsupported|too_large|empty), error TEXT, page_count INT, storage_path TEXT, created_at`
唯一约束：`(batch_id, content_hash)` 之外的重复由全局哈希索引判定 → status=duplicate。

### error_item（错题条目）
`id TEXT PK, short_id TEXT UNIQUE（如 M-03）, student_id FK, batch_id FK, asset_id FK, item_index INT,
subject TEXT, chapter TEXT, knowledge_tags TEXT(JSON), question_type TEXT,
status TEXT（见状态机）, confidence REAL, needs_correction INT,
has_question_img INT, has_work_img INT, has_answer_img INT, has_teacher_note INT,
text_excerpt TEXT（mock/真实提取的题目文本摘要）,
ai_suggestion TEXT(JSON 建议+字段级置信度，仅供展示),
archived_reason TEXT, created_at, updated_at`
唯一约束：`(asset_id, item_index)`（重试幂等）。

### error_diagnosis（学生反思，家长不可见）
`id TEXT PK, item_id FK, attempt_state TEXT, cause TEXT, mastery_feeling INT, review_value TEXT,
submitted_by TEXT DEFAULT 'student', created_at`
约束：API 层强制 `submitted_by='student'`。

### knowledge_tag（复发检测维度的规范化标签）
`id TEXT PK, subject TEXT, name TEXT`（如 数学/一元二次方程）

### review_recommendation（评分快照，可解释）
`id TEXT PK, item_id FK, week TEXT, score INT, reasons TEXT(JSON 文案数组), conflict_flag INT, created_at`

### review_packet
`id TEXT PK, student_id FK, week TEXT, status TEXT(scheduled|generated|returned), planned_date TEXT, pdf_path TEXT, created_at`

### review_packet_item
`packet_id FK, item_id FK, position INT, hint_text TEXT, answer_text TEXT, PK(packet_id,item_id)`

### review_attempt（回传结果）
`id TEXT PK, packet_id FK, item_id FK, completion TEXT(independent|unsure|hint_used|failed|unfinished), correct INT, stuck_step TEXT NULL, submitted_by TEXT DEFAULT 'student', created_at`

### mastery_event（掌握事件，追加式）
`id TEXT PK, item_id FK, from_status TEXT, to_status TEXT, reason TEXT, created_at`

### ai_run（AI 调用审计，不含图片/反思内容）
`id TEXT PK, provider TEXT, operation TEXT, asset_id TEXT NULL, item_id TEXT NULL, status TEXT(ok|timeout|invalid_json|error), latency_ms INT, error TEXT, created_at`

### audit_event（产品事件，最小集）
`id TEXT PK, name TEXT, entity_type TEXT, entity_id TEXT, created_at`（无文本内容字段）

## 状态机
错题状态集合与流转规则见 PRD §9.1；掌握规则见 PRD §9.2；评分规则见 PRD §9.3。实现位于 `src/domain/`（纯函数）。

## 索引
- error_item(student_id, status)
- error_item(short_id) UNIQUE
- source_asset(content_hash)
- review_attempt(item_id, created_at)
- mastery_event(item_id, created_at)
