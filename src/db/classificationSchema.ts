/** Stage values stored in the historical grade column. Year grades are not allowed. */
export const ITEM_CATEGORY_COLUMNS_SQL = `
  item_id TEXT NOT NULL PRIMARY KEY,
  student_id TEXT NOT NULL,
  grade TEXT NOT NULL CHECK (grade IN ('初中','高中')),
  subject TEXT CHECK (subject IS NULL OR (subject=trim(subject) AND length(subject) BETWEEN 1 AND 100)),
  chapter TEXT CHECK (chapter IS NULL OR (chapter=trim(chapter) AND length(chapter) BETWEEN 1 AND 100)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (item_id,student_id) REFERENCES error_item(id,student_id) ON DELETE CASCADE`;

/** Additive classification schema. Keep migrations here: production deployment must review them. */
export const CLASSIFICATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS learning_stage (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100)
);
INSERT OR IGNORE INTO learning_stage (id,name) VALUES ('junior','初中');
INSERT OR IGNORE INTO learning_stage (id,name) VALUES ('senior','高中');

CREATE TABLE IF NOT EXISTS classification_catalog (
  student_id TEXT NOT NULL REFERENCES student_profile(id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL REFERENCES learning_stage(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (student_id,stage_id)
);

CREATE TABLE IF NOT EXISTS classification_subject (
  id TEXT NOT NULL PRIMARY KEY,
  student_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  standard_key TEXT,
  name TEXT NOT NULL COLLATE NOCASE CHECK (name=trim(name) AND length(name) BETWEEN 1 AND 100),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (student_id,stage_id,standard_key),
  UNIQUE (student_id,stage_id,name),
  UNIQUE (id,student_id,stage_id),
  FOREIGN KEY (student_id,stage_id) REFERENCES classification_catalog(student_id,stage_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS classification_topic (
  id TEXT NOT NULL PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES classification_subject(id) ON DELETE CASCADE,
  standard_key TEXT,
  name TEXT NOT NULL COLLATE NOCASE CHECK (name=trim(name) AND length(name) BETWEEN 1 AND 100),
  aliases_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json) AND json_type(aliases_json)='array'),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (subject_id,standard_key),
  UNIQUE (subject_id,name),
  UNIQUE (id,subject_id)
);

-- Composite keys enforce ownership even inside a database containing several synthetic/legacy profiles.
CREATE UNIQUE INDEX IF NOT EXISTS idx_classification_item_owner ON error_item(id,student_id);
-- Per-item grade snapshot and optional manual category overrides. Raw AI evidence stays intact.
-- Additive table: existing releases can still read the original question tables.
CREATE TABLE IF NOT EXISTS item_category (${ITEM_CATEGORY_COLUMNS_SQL}
);
CREATE TABLE IF NOT EXISTS item_classification (
  item_id TEXT NOT NULL PRIMARY KEY,
  student_id TEXT NOT NULL,
  stage_id TEXT NOT NULL DEFAULT 'junior',
  subject_id TEXT,
  subject_source TEXT CHECK (subject_source IN ('ai','manual')),
  knowledge_source TEXT CHECK (knowledge_source IN ('ai','manual')),
  subject_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (subject_confirmed IN (0,1)),
  knowledge_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (knowledge_confirmed IN (0,1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','classified','needs_confirmation','failed')),
  input_revision INTEGER NOT NULL DEFAULT 0 CHECK (input_revision >= 0),
  suggestions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(suggestions_json) AND json_type(suggestions_json)='array'),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (item_id,subject_id),
  FOREIGN KEY (item_id,student_id) REFERENCES error_item(id,student_id) ON DELETE CASCADE,
  FOREIGN KEY (student_id,stage_id) REFERENCES classification_catalog(student_id,stage_id) ON DELETE CASCADE,
  FOREIGN KEY (subject_id,student_id,stage_id) REFERENCES classification_subject(id,student_id,stage_id)
);
CREATE INDEX IF NOT EXISTS idx_classification_filter ON item_classification(student_id,stage_id,subject_id,status);

CREATE TABLE IF NOT EXISTS item_classification_topic (
  item_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  PRIMARY KEY (item_id,topic_id),
  FOREIGN KEY (item_id,subject_id) REFERENCES item_classification(item_id,subject_id) ON DELETE CASCADE,
  FOREIGN KEY (topic_id,subject_id) REFERENCES classification_topic(id,subject_id)
);
CREATE INDEX IF NOT EXISTS idx_classification_topic_items ON item_classification_topic(topic_id,item_id);

-- Preserve the student's upload-time choice while asynchronous recognition has not created items yet.
CREATE UNIQUE INDEX IF NOT EXISTS idx_classification_photo_owner ON v2_photo(job_id,student_id);
CREATE TABLE IF NOT EXISTS photo_subject_selection (
  job_id TEXT NOT NULL PRIMARY KEY,
  student_id TEXT NOT NULL,
  stage_id TEXT NOT NULL DEFAULT 'junior',
  subject_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id,student_id) REFERENCES v2_photo(job_id,student_id) ON DELETE CASCADE,
  FOREIGN KEY (subject_id,student_id,stage_id) REFERENCES classification_subject(id,student_id,stage_id)
);

-- Persistent bookkeeping for PR5. No historical processing or AI runs during migration.
CREATE TABLE IF NOT EXISTS classification_batch (
  id TEXT NOT NULL PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES student_profile(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id,student_id)
);
CREATE TABLE IF NOT EXISTS classification_task (
  batch_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  input_revision INTEGER NOT NULL DEFAULT 0 CHECK (input_revision >= 0),
  lease_until TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (batch_id,item_id),
  FOREIGN KEY (batch_id,student_id) REFERENCES classification_batch(id,student_id) ON DELETE CASCADE,
  FOREIGN KEY (item_id,student_id) REFERENCES error_item(id,student_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_classification_task_queue ON classification_task(batch_id,status,lease_until,item_id);
`;
