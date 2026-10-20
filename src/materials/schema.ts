import type { DatabaseSync } from 'node:sqlite';

/** Additive only: legacy source and learning rows remain untouched. */
export function migrateMaterials(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS material_workspace (
      owner_id TEXT PRIMARY KEY REFERENCES student_profile(id),
      draft_namespace TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS material_capture (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES material_workspace(owner_id),
      request_id TEXT NOT NULL, source_batch_id TEXT REFERENCES source_batch(id),
      status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(owner_id,id), UNIQUE(owner_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS material_document (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES material_workspace(owner_id),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      clues_json TEXT NOT NULL DEFAULT '{}', label TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(owner_id,id)
    );
    CREATE TABLE IF NOT EXISTS material_asset (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES material_workspace(owner_id),
      capture_id TEXT NOT NULL, source_asset_id TEXT NOT NULL REFERENCES source_asset(id),
      document_id TEXT, upload_request_id TEXT, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      link_revision INTEGER NOT NULL DEFAULT 1 CHECK(link_revision > 0),
      hints_json TEXT NOT NULL DEFAULT '{}', extraction_json TEXT, status TEXT NOT NULL DEFAULT 'saved',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(owner_id,id), UNIQUE(owner_id,source_asset_id), UNIQUE(owner_id,upload_request_id),
      FOREIGN KEY(owner_id,capture_id) REFERENCES material_capture(owner_id,id),
      FOREIGN KEY(owner_id,document_id) REFERENCES material_document(owner_id,id)
    );
    CREATE TABLE IF NOT EXISTS material_fragment (
      id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
      owner_id TEXT NOT NULL, asset_id TEXT NOT NULL, content_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(id,revision), UNIQUE(owner_id,id,revision),
      FOREIGN KEY(owner_id,asset_id) REFERENCES material_asset(owner_id,id)
    );
    CREATE TABLE IF NOT EXISTS material_question (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES material_workspace(owner_id), document_id TEXT,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0), number TEXT, subject TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]', unresolved_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(owner_id,id),
      FOREIGN KEY(owner_id,document_id) REFERENCES material_document(owner_id,id)
    );
    CREATE TABLE IF NOT EXISTS material_attempt (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, question_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(owner_id,id), UNIQUE(owner_id,question_id,id),
      FOREIGN KEY(owner_id,question_id) REFERENCES material_question(owner_id,id)
    );
    CREATE TABLE IF NOT EXISTS material_link_event (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, fragment_id TEXT NOT NULL, fragment_revision INTEGER NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0), question_id TEXT, attempt_id TEXT,
      before_question_id TEXT, before_attempt_id TEXT, before_fragment_revision INTEGER,
      decision TEXT NOT NULL DEFAULT 'manual', basis_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(owner_id,fragment_id,revision),
      CHECK(attempt_id IS NULL OR question_id IS NOT NULL),
      CHECK(before_attempt_id IS NULL OR before_question_id IS NOT NULL),
      FOREIGN KEY(owner_id,fragment_id,fragment_revision) REFERENCES material_fragment(owner_id,id,revision),
      FOREIGN KEY(owner_id,fragment_id,before_fragment_revision) REFERENCES material_fragment(owner_id,id,revision),
      FOREIGN KEY(owner_id,question_id) REFERENCES material_question(owner_id,id),
      FOREIGN KEY(owner_id,question_id,attempt_id) REFERENCES material_attempt(owner_id,question_id,id),
      FOREIGN KEY(owner_id,before_question_id) REFERENCES material_question(owner_id,id),
      FOREIGN KEY(owner_id,before_question_id,before_attempt_id) REFERENCES material_attempt(owner_id,question_id,id)
    );
    CREATE TABLE IF NOT EXISTS material_answer (
      id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), owner_id TEXT NOT NULL,
      question_id TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('imported','manual','ai')),
      basis_key TEXT NOT NULL, dependencies_json TEXT NOT NULL DEFAULT '[]', content_json TEXT NOT NULL,
      stale INTEGER NOT NULL DEFAULT 0 CHECK(stale IN (0,1)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(id,revision), UNIQUE(owner_id,id,revision),
      FOREIGN KEY(owner_id,question_id) REFERENCES material_question(owner_id,id)
    );
    CREATE TABLE IF NOT EXISTS material_grade (
      id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0), owner_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL, basis_key TEXT NOT NULL, dependencies_json TEXT NOT NULL DEFAULT '[]',
      content_json TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0 CHECK(stale IN (0,1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(id,revision),
      FOREIGN KEY(owner_id,attempt_id) REFERENCES material_attempt(owner_id,id)
    );
    CREATE TABLE IF NOT EXISTS material_job (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES material_workspace(owner_id),
      request_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('extract','answer','grade')),
      question_id TEXT, asset_id TEXT, basis_key TEXT NOT NULL DEFAULT '',
      dependencies_json TEXT NOT NULL DEFAULT '[]', input_json TEXT NOT NULL DEFAULT '{}', result_json TEXT,
      state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed','interrupted','stale')),
      error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(owner_id,question_id) REFERENCES material_question(owner_id,id),
      FOREIGN KEY(owner_id,asset_id) REFERENCES material_asset(owner_id,id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_material_job_request ON material_job(owner_id,request_id,kind,COALESCE(question_id,''),COALESCE(asset_id,''));
    CREATE TABLE IF NOT EXISTS material_item_link (
      owner_id TEXT NOT NULL, question_id TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES error_item(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(owner_id,question_id), UNIQUE(item_id),
      FOREIGN KEY(owner_id,question_id) REFERENCES material_question(owner_id,id)
    );
    CREATE TABLE IF NOT EXISTS material_legacy_map (
      owner_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_key TEXT NOT NULL,
      question_id TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(owner_id,source_kind,source_key),
      FOREIGN KEY(owner_id,question_id) REFERENCES material_question(owner_id,id)
    );
    CREATE INDEX IF NOT EXISTS idx_material_question_document ON material_question(owner_id,document_id);
    CREATE INDEX IF NOT EXISTS idx_material_links_question ON material_link_event(owner_id,question_id);
    CREATE INDEX IF NOT EXISTS idx_material_fragments_asset ON material_fragment(owner_id,asset_id);
  `);
  // Link decisions have their own CAS counter: they never change extraction/source identity.
  const assetColumns=db.prepare('PRAGMA table_info(material_asset)').all() as {name:string}[];
  if (!assetColumns.some(column=>column.name==='link_revision')) db.exec('ALTER TABLE material_asset ADD COLUMN link_revision INTEGER NOT NULL DEFAULT 1 CHECK(link_revision > 0)');
  // Old hints may already have been edited. NULL means the original request is
  // unknown; never backfill a replay identity from current display/link metadata.
  if (!assetColumns.some(column=>column.name==='upload_request_fingerprint')) db.exec('ALTER TABLE material_asset ADD COLUMN upload_request_fingerprint TEXT');
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS material_upload_fingerprint_immutable
    BEFORE UPDATE OF upload_request_fingerprint ON material_asset
    WHEN NEW.upload_request_fingerprint IS NOT OLD.upload_request_fingerprint
    BEGIN SELECT RAISE(ABORT,'upload request fingerprint is immutable'); END;
  `);
  // Old tables do not have composite owner keys. Validate those boundaries without changing old rows.
  for (const operation of ['INSERT', 'UPDATE'] as const) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS material_capture_owner_${operation} BEFORE ${operation} ON material_capture
      WHEN NEW.source_batch_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM source_batch WHERE id=NEW.source_batch_id AND student_id=NEW.owner_id
      ) BEGIN SELECT RAISE(ABORT,'source batch owner mismatch'); END;
      CREATE TRIGGER IF NOT EXISTS material_asset_owner_${operation} BEFORE ${operation} ON material_asset
      WHEN NOT EXISTS (
        SELECT 1 FROM source_asset a JOIN source_batch b ON b.id=a.batch_id
        WHERE a.id=NEW.source_asset_id AND b.student_id=NEW.owner_id
      ) BEGIN SELECT RAISE(ABORT,'source asset owner mismatch'); END;
      CREATE TRIGGER IF NOT EXISTS material_item_owner_${operation} BEFORE ${operation} ON material_item_link
      WHEN NOT EXISTS (SELECT 1 FROM error_item WHERE id=NEW.item_id AND student_id=NEW.owner_id)
      BEGIN SELECT RAISE(ABORT,'learning item owner mismatch'); END;
    `);
  }
}
