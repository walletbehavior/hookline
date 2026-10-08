-- Runtime-family subscriptions are separate from project follows and address
-- alerts. An appearance means Hookline first observed the exact runtime on a
-- monitored deployment; it is not proof that the contract was just deployed.
CREATE TABLE IF NOT EXISTS runtime_family_appearances (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  UNIQUE(fingerprint, chain_id, address)
);
CREATE INDEX IF NOT EXISTS runtime_family_appearances_feed
  ON runtime_family_appearances(fingerprint, observed_at DESC);

CREATE TABLE IF NOT EXISTS runtime_family_follows (
  id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  label TEXT,
  baseline_deployments_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(baseline_deployments_json)),
  created_at INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  UNIQUE(telegram_user_id, chat_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS runtime_family_follows_delivery
  ON runtime_family_follows(enabled, fingerprint);

CREATE TABLE IF NOT EXISTS runtime_family_deliveries (
  follow_id TEXT NOT NULL,
  appearance_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  delivered_at INTEGER,
  PRIMARY KEY(follow_id, appearance_id)
);
CREATE INDEX IF NOT EXISTS runtime_family_deliveries_age
  ON runtime_family_deliveries(attempted_at);
