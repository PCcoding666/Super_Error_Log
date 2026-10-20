import { CLASSIFICATION_SCHEMA_SQL } from './classificationSchema.js';
import { PRACTICE_SUBMISSION_SCHEMA_SQL } from './practiceSubmissionSchema.js';

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
-- v2.1a：selected_by_student 记录该题是否由学生勾入（0 自动痕迹题 / 1 学生勾选）。
CREATE TABLE IF NOT EXISTS mobile_item_link (
  item_id TEXT PRIMARY KEY REFERENCES error_item(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  question_revision INTEGER NOT NULL,
  selected_by_student INTEGER NOT NULL DEFAULT 0,
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

-- v2.0 T4e：修改记录（修正即测量）。被接受的每一条修改记一笔：字段、改前、改后、方式、时间。
-- before_text/after_text 只存库供测量与学生端对照，不进日志、不进家长聚合。
CREATE TABLE IF NOT EXISTS correction (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES error_item(id),
  field TEXT NOT NULL,
  observation_id TEXT,
  before_text TEXT,
  after_text TEXT,
  method TEXT NOT NULL CHECK (method IN ('voice','keyboard','direct')),
  proposal_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_correction_item ON correction(item_id, created_at);

-- v2.0 T4e：修改建议。client_request_id 全局唯一（重放返回同一结果、不再调用模型）；
-- 建议 10 分钟内有效，被接受后写 accepted_at。instruction 只存库，不进日志。
-- error 非空表示该次模型调用失败（R1-F2：失败也计入限流；不可被接受）。
CREATE TABLE IF NOT EXISTS correction_proposal (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES error_item(id),
  base_revision INTEGER NOT NULL,
  client_request_id TEXT NOT NULL UNIQUE,
  instruction TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('voice','keyboard')),
  changes_json TEXT NOT NULL,
  clarify TEXT,
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_correction_proposal_item ON correction_proposal(item_id, created_at);

-- v2.0 T5：打印快照（D17：服务器冻结结构化内容+图片，PDF 由手机生成）。
-- 每个 v2 练习包最多一份快照；preparing 时 snapshot_json 存部分进度（供重启续做），ready 后为终态。
CREATE TABLE IF NOT EXISTS v2_print_snapshot (
  packet_id TEXT PRIMARY KEY REFERENCES review_packet(id),
  status TEXT NOT NULL CHECK (status IN ('preparing','ready','failed')),
  progress_done INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  snapshot_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  ready_at TEXT
);
${CLASSIFICATION_SCHEMA_SQL}

CREATE TABLE IF NOT EXISTS practice_progress (
  packet_id TEXT PRIMARY KEY REFERENCES review_packet(id) ON DELETE CASCADE,
  cursor_item TEXT
);
CREATE TABLE IF NOT EXISTS practice_task (
  packet_id TEXT PRIMARY KEY REFERENCES review_packet(id) ON DELETE CASCADE,
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','paused','cancelled')),
  request_key TEXT UNIQUE,
  original_statuses TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS practice_question_progress (
  packet_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  hint_level INTEGER NOT NULL DEFAULT 0 CHECK(hint_level BETWEEN 0 AND 2),
  PRIMARY KEY(packet_id, item_id),
  FOREIGN KEY(packet_id,item_id) REFERENCES review_packet_item(packet_id,item_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS practice_work (
  id TEXT PRIMARY KEY,
  packet_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  request_key TEXT NOT NULL UNIQUE,
  source_hash TEXT NOT NULL,
  image BLOB NOT NULL,
  status TEXT NOT NULL,
  text TEXT,
  uncertain INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(packet_id,item_id) REFERENCES review_packet_item(packet_id,item_id) ON DELETE CASCADE
);
${PRACTICE_SUBMISSION_SCHEMA_SQL}
`;
