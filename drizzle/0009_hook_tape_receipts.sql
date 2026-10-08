-- Bounded receipt enrichment for retained Hook Tape swaps. Only normalized
-- ERC-20 Transfer logs touching a saved hook or one of its pool currencies are
-- retained. These rows are observable transaction flows, not fee attribution.
CREATE TABLE IF NOT EXISTS hook_tape_receipts (
  transaction_hash TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  status INTEGER NOT NULL CHECK(status = 1),
  gas_used TEXT NOT NULL,
  effective_gas_price TEXT,
  logs_count INTEGER NOT NULL,
  transfer_logs INTEGER NOT NULL,
  hook_linked_transfers INTEGER NOT NULL,
  currency_transfers INTEGER NOT NULL,
  selected_transfers INTEGER NOT NULL,
  truncated INTEGER NOT NULL CHECK(truncated IN (0, 1)),
  transfers_json TEXT NOT NULL CHECK(json_valid(transfers_json)),
  observed_at INTEGER NOT NULL,
  finalized_at_block INTEGER NOT NULL,
  finalized_at_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hook_tape_receipts_recent
  ON hook_tape_receipts(chain_id,block_number DESC);
