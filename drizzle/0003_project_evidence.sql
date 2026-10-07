CREATE TABLE IF NOT EXISTS project_observations (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, chain_id INTEGER NOT NULL,
 address TEXT NOT NULL, block_number INTEGER NOT NULL, block_hash TEXT NOT NULL,
 observed_at INTEGER NOT NULL, payload_json TEXT NOT NULL, canonical INTEGER NOT NULL DEFAULT 1,
 UNIQUE(project_id,chain_id,address,block_hash)
);
CREATE INDEX IF NOT EXISTS project_observations_latest ON project_observations(project_id,chain_id,address,observed_at DESC);
CREATE INDEX IF NOT EXISTS project_observations_age ON project_observations(observed_at);
CREATE INDEX IF NOT EXISTS project_observations_canonical ON project_observations(project_id,chain_id,address,canonical,block_number DESC);
CREATE TABLE IF NOT EXISTS project_events (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, chain_id INTEGER NOT NULL,
 address TEXT NOT NULL, block_number INTEGER NOT NULL, block_hash TEXT NOT NULL,
 observed_at INTEGER NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
 canonical INTEGER NOT NULL DEFAULT 1, occurred_at INTEGER, notification_at INTEGER
);
CREATE INDEX IF NOT EXISTS project_events_feed ON project_events(canonical,observed_at DESC);
CREATE INDEX IF NOT EXISTS project_events_project ON project_events(project_id,canonical,observed_at DESC);
CREATE TABLE IF NOT EXISTS project_scan_state (
 target TEXT PRIMARY KEY, last_checked_at INTEGER NOT NULL DEFAULT 0,
 last_success_at INTEGER, log_cursor INTEGER, cursor_hash TEXT, failure TEXT,
 log_checked_at INTEGER, log_success_at INTEGER, log_failure TEXT,
 log_tip INTEGER, log_lag_blocks INTEGER, log_status TEXT,
 log_coverage_start INTEGER, log_cursor_timestamp INTEGER, notification_after_block INTEGER
);
CREATE TABLE IF NOT EXISTS project_follows (
 id TEXT PRIMARY KEY, telegram_user_id TEXT NOT NULL, chat_id TEXT NOT NULL,
 project_id TEXT NOT NULL, created_at INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
 UNIQUE(telegram_user_id,chat_id,project_id)
);
CREATE INDEX IF NOT EXISTS project_follows_delivery ON project_follows(enabled,project_id);
CREATE TABLE IF NOT EXISTS project_deliveries (
 follow_id TEXT NOT NULL, event_id TEXT NOT NULL, status TEXT NOT NULL,
 attempted_at INTEGER NOT NULL, delivered_at INTEGER,
 PRIMARY KEY(follow_id,event_id)
);
CREATE INDEX IF NOT EXISTS project_deliveries_age ON project_deliveries(attempted_at);
CREATE TABLE IF NOT EXISTS project_scan_locks (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, lease_until INTEGER NOT NULL
);
