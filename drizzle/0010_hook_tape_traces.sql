-- Bounded parity-style transaction traces for retained successful Hook Tape
-- swaps. Only hook-linked call frames and relevant native-value paths are
-- stored. A selected trace is call-path evidence, not complete swap coverage or
-- automatic fee attribution.
CREATE TABLE IF NOT EXISTS hook_tape_traces (
  transaction_hash TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  trace_items INTEGER NOT NULL,
  hook_calls INTEGER NOT NULL,
  hook_outbound_calls INTEGER NOT NULL,
  failed_hook_calls INTEGER NOT NULL,
  hook_call_gas_used TEXT NOT NULL,
  native_value_calls INTEGER NOT NULL,
  selected_calls INTEGER NOT NULL,
  truncated INTEGER NOT NULL CHECK(truncated IN (0, 1)),
  calls_json TEXT NOT NULL CHECK(json_valid(calls_json)),
  observed_at INTEGER NOT NULL,
  finalized_at_block INTEGER NOT NULL,
  finalized_at_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hook_tape_traces_recent
  ON hook_tape_traces(chain_id,block_number DESC);
