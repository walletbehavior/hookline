-- Finalized Uniswap v4 PoolManager swap evidence for already-resolved hooked
-- pools. Values are retained in raw base units so later derivations remain
-- reproducible without inventing token precision or hook-fee attribution.
CREATE TABLE IF NOT EXISTS hook_tape_swaps (
  event_id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  manager_address TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  hook_address TEXT NOT NULL,
  currency0 TEXT NOT NULL,
  currency1 TEXT NOT NULL,
  sender TEXT NOT NULL,
  amount0 TEXT NOT NULL,
  amount1 TEXT NOT NULL,
  sqrt_price_x96 TEXT NOT NULL,
  liquidity TEXT NOT NULL,
  tick INTEGER NOT NULL,
  pool_fee_raw INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  finalized_at_block INTEGER NOT NULL,
  finalized_at_hash TEXT NOT NULL,
  raw_log_json TEXT NOT NULL,
  UNIQUE(chain_id,transaction_hash,log_index)
);
CREATE INDEX IF NOT EXISTS hook_tape_swaps_recent
  ON hook_tape_swaps(chain_id,block_number DESC,log_index DESC);
CREATE INDEX IF NOT EXISTS hook_tape_swaps_hook
  ON hook_tape_swaps(chain_id,hook_address,block_number DESC,log_index DESC);
CREATE INDEX IF NOT EXISTS hook_tape_swaps_pool
  ON hook_tape_swaps(chain_id,pool_id,block_number DESC,log_index DESC);

CREATE TABLE IF NOT EXISTS hook_tape_swap_state (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  manager_address TEXT NOT NULL,
  live_started_block INTEGER,
  live_next_block INTEGER,
  finalized_block INTEGER,
  finalized_hash TEXT,
  source_logs_seen INTEGER NOT NULL DEFAULT 0,
  saved_swaps INTEGER NOT NULL DEFAULT 0,
  last_checked_at INTEGER NOT NULL DEFAULT 0,
  last_success_at INTEGER,
  last_failure TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);
