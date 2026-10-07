-- First-party Uniswap v4 PoolManager initialization evidence.
-- The scanner stores finalized source logs and advances only after writes succeed.
CREATE TABLE IF NOT EXISTS hook_tape_pools (
  event_id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  manager_address TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  hook_address TEXT NOT NULL,
  currency0 TEXT NOT NULL,
  currency1 TEXT NOT NULL,
  fee_raw INTEGER NOT NULL,
  fee_mode TEXT NOT NULL CHECK(fee_mode IN ('static','dynamic')),
  tick_spacing INTEGER NOT NULL,
  sqrt_price_x96 TEXT NOT NULL,
  initial_tick INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  finalized_at_block INTEGER NOT NULL,
  finalized_at_hash TEXT NOT NULL,
  raw_log_json TEXT NOT NULL,
  UNIQUE(chain_id,manager_address,pool_id),
  UNIQUE(chain_id,transaction_hash,log_index)
);
CREATE INDEX IF NOT EXISTS hook_tape_pools_recent
  ON hook_tape_pools(chain_id,block_number DESC,log_index DESC);
CREATE INDEX IF NOT EXISTS hook_tape_pools_hook
  ON hook_tape_pools(chain_id,hook_address,block_number DESC,log_index DESC);

CREATE TABLE IF NOT EXISTS hook_tape_scan_state (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  manager_address TEXT NOT NULL,
  deployment_block INTEGER NOT NULL,
  historical_next_block INTEGER NOT NULL,
  live_started_block INTEGER,
  live_next_block INTEGER,
  finalized_block INTEGER,
  finalized_hash TEXT,
  historical_complete INTEGER NOT NULL DEFAULT 0,
  last_checked_at INTEGER NOT NULL DEFAULT 0,
  last_success_at INTEGER,
  last_failure TEXT,
  lease_owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
