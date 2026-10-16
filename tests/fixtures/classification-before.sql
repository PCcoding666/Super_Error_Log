-- Relevant pre-classification tables from d3ac4a9; contains schema only, no student data.

CREATE TABLE IF NOT EXISTS student_profile (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  grade TEXT NOT NULL DEFAULT '初三',
  subjects TEXT NOT NULL DEFAULT '["数学","物理","化学"]',
  weekend_pref TEXT DEFAULT '周六上午',
  created_at TEXT NOT NULL
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
