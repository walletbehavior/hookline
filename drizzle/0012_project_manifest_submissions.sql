-- Private, review-only machine-readable project claims. These tables are not
-- joined into the public registry or scanner configuration.
CREATE TABLE IF NOT EXISTS project_manifest_submissions (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  manifest_hash TEXT NOT NULL UNIQUE,
  capability_hash TEXT NOT NULL,
  receipt_expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending_review','reviewed','rejected','revoked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewer_id TEXT
);
CREATE INDEX IF NOT EXISTS project_manifest_submissions_queue ON project_manifest_submissions(status,created_at);
CREATE INDEX IF NOT EXISTS project_manifest_submissions_actor ON project_manifest_submissions(actor_key,created_at);

CREATE TABLE IF NOT EXISTS project_manifest_limits (
  bucket_key TEXT PRIMARY KEY NOT NULL,
  hits INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_manifest_audit (
  id TEXT PRIMARY KEY NOT NULL,
  submission_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason_detail TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(submission_id) REFERENCES project_manifest_submissions(id)
);
CREATE INDEX IF NOT EXISTS project_manifest_audit_submission ON project_manifest_audit(submission_id,created_at);
