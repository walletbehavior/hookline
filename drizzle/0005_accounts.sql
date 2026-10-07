-- Wallet signatures authenticate private account data only. No signing keys,
-- trade permissions, raw signatures, session tokens, or Telegram link tokens.
CREATE TABLE IF NOT EXISTS accounts (
  address TEXT PRIMARY KEY CHECK(length(address)=42 AND substr(address,1,2)='0x' AND substr(address,3) NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account_challenges (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  chain_id INTEGER NOT NULL CHECK(chain_id>0),
  nonce TEXT NOT NULL UNIQUE,
  message TEXT NOT NULL CHECK(length(message)<=2048),
  browser_hash TEXT NOT NULL CHECK(length(browser_hash)=64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at AND expires_at-created_at<=600000),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  consumed_at INTEGER,
  consumed_by TEXT
);
CREATE INDEX IF NOT EXISTS account_challenges_expiry ON account_challenges(expires_at);

CREATE TABLE IF NOT EXISTS account_sessions (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
  account_address TEXT NOT NULL REFERENCES accounts(address) ON DELETE CASCADE,
  chain_id INTEGER NOT NULL CHECK(chain_id>0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at AND expires_at-created_at<=604800000),
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS account_sessions_account ON account_sessions(account_address,revoked_at,created_at);
CREATE INDEX IF NOT EXISTS account_sessions_expiry ON account_sessions(expires_at);

CREATE TABLE IF NOT EXISTS account_documents (
  account_address TEXT NOT NULL REFERENCES accounts(address) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('watchlists','preferences')),
  document_json TEXT NOT NULL CHECK(json_valid(document_json) AND json_type(document_json)='object' AND length(CAST(document_json AS BLOB))<=262144),
  revision INTEGER NOT NULL CHECK(revision>0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(account_address,kind)
);

CREATE TABLE IF NOT EXISTS account_telegram_link_tokens (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
  account_address TEXT NOT NULL REFERENCES accounts(address) ON DELETE CASCADE,
  session_hash TEXT NOT NULL REFERENCES account_sessions(token_hash) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at AND expires_at-created_at<=600000),
  consumed_at INTEGER,
  consumed_by TEXT,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS account_telegram_tokens_account ON account_telegram_link_tokens(account_address,expires_at);
CREATE INDEX IF NOT EXISTS account_telegram_tokens_expiry ON account_telegram_link_tokens(expires_at);

CREATE TABLE IF NOT EXISTS account_telegram_links (
  account_address TEXT PRIMARY KEY REFERENCES accounts(address) ON DELETE CASCADE,
  telegram_user_id TEXT NOT NULL UNIQUE CHECK(length(telegram_user_id) BETWEEN 1 AND 20 AND substr(telegram_user_id,1,1) BETWEEN '1' AND '9' AND telegram_user_id NOT GLOB '*[^0-9]*'),
  linked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account_auth_limits (
  bucket_key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL CHECK(hits>0),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS account_auth_limits_expiry ON account_auth_limits(expires_at);
