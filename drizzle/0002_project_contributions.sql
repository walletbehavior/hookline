CREATE TABLE IF NOT EXISTS project_submissions (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('project','claim','correction')),
  project_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  telegram_user_id TEXT,
  chat_id TEXT,
  request_id TEXT,
  payload_json TEXT NOT NULL,
  capability_hash TEXT NOT NULL,
  capability_expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_review','awaiting_proof','verified_owner','approved','rejected','revoked')),
  reason_code TEXT NOT NULL,
  reason_detail TEXT NOT NULL,
  canonical_domain TEXT,
  challenge_hash TEXT,
  challenge_expires_at INTEGER,
  proof_json TEXT,
  review_token TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS project_submissions_actor_day ON project_submissions(actor_key,created_at);
CREATE INDEX IF NOT EXISTS project_submissions_created ON project_submissions(created_at);
CREATE INDEX IF NOT EXISTS project_submissions_review ON project_submissions(status,created_at);
CREATE INDEX IF NOT EXISTS project_submissions_telegram ON project_submissions(telegram_user_id,chat_id,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS project_submissions_request ON project_submissions(actor_key,request_id) WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS project_contribution_limits (
  bucket_key TEXT PRIMARY KEY NOT NULL,
  hits INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS project_contribution_limits_expiry ON project_contribution_limits(expires_at);

CREATE TABLE IF NOT EXISTS project_owners (
  project_id TEXT PRIMARY KEY NOT NULL,
  submission_id TEXT NOT NULL UNIQUE,
  verified_domain TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (submission_id) REFERENCES project_submissions(id)
);

CREATE TABLE IF NOT EXISTS project_metadata (
  project_id TEXT PRIMARY KEY NOT NULL,
  metadata_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  source_submission_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (source_submission_id) REFERENCES project_submissions(id)
);

-- Agent-reviewed canonical domains are independent of team-editable metadata.
CREATE TABLE IF NOT EXISTS project_authorities (
  project_id TEXT PRIMARY KEY NOT NULL,
  website TEXT NOT NULL,
  source_url TEXT NOT NULL,
  reviewed_at INTEGER NOT NULL,
  source_submission_id TEXT NOT NULL,
  FOREIGN KEY (source_submission_id) REFERENCES project_submissions(id)
);

CREATE TABLE IF NOT EXISTS project_contribution_audit (
  id TEXT PRIMARY KEY NOT NULL,
  submission_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason_detail TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES project_submissions(id)
);
CREATE INDEX IF NOT EXISTS project_contribution_audit_submission ON project_contribution_audit(submission_id,created_at);
CREATE INDEX IF NOT EXISTS project_contribution_audit_project ON project_contribution_audit(project_id,created_at);
