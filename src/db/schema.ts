export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS student_profile (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  grade TEXT NOT NULL DEFAULT '初三',
  subjects TEXT NOT NULL DEFAULT '["数学","物理","化学"]',
  weekend_pref TEXT DEFAULT '周六上午',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS guardian_view_policy (
  student_id TEXT PRIMARY KEY REFERENCES student_profile(id),
  mode TEXT NOT NULL DEFAULT 'aggregate_only',
  show_subject_trend INTEGER NOT NULL DEFAULT 1,
  show_completion INTEGER NOT NULL DEFAULT 1,
  show_mastery_trend INTEGER NOT NULL DEFAULT 1,
  show_reflections INTEGER NOT NULL DEFAULT 0,
  show_item_detail INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS source_batch (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES student_profile(id),
  status TEXT NOT NULL DEFAULT 'processing',
  total_files INTEGER NOT NULL DEFAULT 0,
  done_files INTEGER NOT NULL DEFAULT 0,
  failed_files INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_asset (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES source_batch(id),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  page_count INTEGER,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
DROP INDEX IF EXISTS idx_asset_batch_hash;
CREATE INDEX IF NOT EXISTS idx_asset_batch_hash ON source_asset(batch_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_asset_hash ON source_asset(content_hash);

CREATE TABLE IF NOT EXISTS asset_origin (
  asset_id TEXT PRIMARY KEY REFERENCES source_asset(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('mock','openai','bailian'))
);

CREATE TABLE IF NOT EXISTS error_item (
  id TEXT PRIMARY KEY,
  short_id TEXT UNIQUE,
  student_id TEXT NOT NULL REFERENCES student_profile(id),
  batch_id TEXT NOT NULL REFERENCES source_batch(id),
  asset_id TEXT NOT NULL REFERENCES source_asset(id),
  item_index INTEGER NOT NULL,
  subject TEXT,
  chapter TEXT,
  knowledge_tags TEXT NOT NULL DEFAULT '[]',
  question_type TEXT,
  status TEXT NOT NULL DEFAULT 'captured',
  confidence REAL NOT NULL DEFAULT 0,
  needs_correction INTEGER NOT NULL DEFAULT 0,
  has_question_img INTEGER NOT NULL DEFAULT 1,
  has_work_img INTEGER NOT NULL DEFAULT 0,
  has_answer_img INTEGER NOT NULL DEFAULT 0,
  has_teacher_note INTEGER NOT NULL DEFAULT 0,
  text_excerpt TEXT,
  ai_suggestion TEXT,
  is_key_gap INTEGER NOT NULL DEFAULT 0,
  next_review_at TEXT,
  archived_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_item_asset_idx ON error_item(asset_id, item_index);
CREATE INDEX IF NOT EXISTS idx_item_student_status ON error_item(student_id, status);

CREATE TABLE IF NOT EXISTS evidence_record (
  item_id TEXT PRIMARY KEY REFERENCES error_item(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1,
  content_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '[]',
  verified INTEGER NOT NULL DEFAULT 0,
  diagnosis_json TEXT,
  coaching_json TEXT,
  crop_audit_json TEXT,
  auto_checks_json TEXT,
  confidence_badge TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS error_diagnosis (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES error_item(id),
  attempt_state TEXT NOT NULL,
  cause TEXT NOT NULL,
  mastery_feeling INTEGER NOT NULL,
  review_value TEXT NOT NULL,
  submitted_by TEXT NOT NULL DEFAULT 'student',
  adopted_ai INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_tag (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  name TEXT NOT NULL,
  UNIQUE(subject, name)
);

CREATE TABLE IF NOT EXISTS review_recommendation (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES error_item(id),
  week TEXT NOT NULL,
  score INTEGER NOT NULL,
  reasons TEXT NOT NULL,
  conflict_flag INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_packet (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES student_profile(id),
  week TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  planned_date TEXT,
  pdf_path TEXT,
  generated_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_packet_item (
  packet_id TEXT NOT NULL REFERENCES review_packet(id),
  item_id TEXT NOT NULL REFERENCES error_item(id),
  position INTEGER NOT NULL,
  hint_text TEXT,
  answer_text TEXT,
  PRIMARY KEY (packet_id, item_id)
);

CREATE TABLE IF NOT EXISTS review_attempt (
  id TEXT PRIMARY KEY,
  packet_id TEXT NOT NULL REFERENCES review_packet(id),
  item_id TEXT NOT NULL REFERENCES error_item(id),
  completion TEXT NOT NULL,
  correct INTEGER NOT NULL DEFAULT 0,
  stuck_step TEXT,
  submitted_by TEXT NOT NULL DEFAULT 'student',
  performed_at TEXT,
  hint_level INTEGER,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attempt_packet_item ON review_attempt(packet_id, item_id);
CREATE INDEX IF NOT EXISTS idx_attempt_item ON review_attempt(item_id, created_at);

CREATE TABLE IF NOT EXISTS mastery_event (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES error_item(id),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mastery_item ON mastery_event(item_id, created_at);

CREATE TABLE IF NOT EXISTS ai_run (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  operation TEXT NOT NULL,
  asset_id TEXT,
  item_id TEXT,
  status TEXT NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_event (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  created_at TEXT NOT NULL
);

-- v2.0 T3：v2 上传照片登记（只桥接登记过的任务；v1 历史任务永不进入学习记录）
-- batch_id/asset_id：该任务首次建题时创建的批次与原图（R1：一个任务最多各一份）；source_hash：判重用。
CREATE TABLE IF NOT EXISTS v2_photo (
  job_id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES student_profile(id),
  registered_at TEXT NOT NULL,
  bridged_revision INTEGER,
  bridge_error TEXT,
  batch_id TEXT,
  asset_id TEXT,
  source_hash TEXT
);

-- v2.0 T3：手机识别题 ↔ Web 错题记录映射
CREATE TABLE IF NOT EXISTS mobile_item_link (
  item_id TEXT PRIMARY KEY REFERENCES error_item(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  question_revision INTEGER NOT NULL,
  UNIQUE(job_id, question_id)
);

-- v2.0 T4a：学生设置（做题时段、原卷通常所在；设计稿 §13 第 4 条）
CREATE TABLE IF NOT EXISTS v2_setting (
  student_id TEXT PRIMARY KEY REFERENCES student_profile(id),
  practice_slot TEXT NOT NULL,
  paper_location TEXT NOT NULL CHECK (paper_location IN ('school','home','varies')),
  updated_at TEXT NOT NULL
);

-- v2.0 T4c：AI 追问轮次。answer/summary_json 含学生原话与 AI 归纳——只给学生本人看，
-- 不进日志、不进家长聚合。每题最多 2 轮（UNIQUE(item_id, turn) 兜底）。
CREATE TABLE IF NOT EXISTS v2_reflection_turn (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES error_item(id),
  turn INTEGER NOT NULL,
  question TEXT NOT NULL,
  question_source TEXT NOT NULL,
  answer TEXT,
  summary_json TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  UNIQUE(item_id, turn)
);
`;
