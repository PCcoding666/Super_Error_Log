/** Task-scoped work is separate from original error imports and never creates learning results. */
export const PRACTICE_SUBMISSION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS practice_submission (
  packet_id TEXT PRIMARY KEY REFERENCES review_packet(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','analyzing','ready','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  findings_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS practice_submission_photo (
  id TEXT PRIMARY KEY,
  packet_id TEXT NOT NULL REFERENCES review_packet(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL UNIQUE,
  source_hash TEXT NOT NULL,
  image BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS practice_submission_photo_packet ON practice_submission_photo(packet_id);
`;
