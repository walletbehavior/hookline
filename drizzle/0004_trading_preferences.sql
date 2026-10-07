CREATE TABLE IF NOT EXISTS trading_preferences (
  telegram_user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  preferences_json TEXT NOT NULL CHECK (
    json_valid(preferences_json)
    AND json_type(preferences_json) = 'object'
    AND length(CAST(preferences_json AS BLOB)) <= 8192
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (telegram_user_id, chat_id),
  CHECK (telegram_user_id = chat_id),
  CHECK (length(telegram_user_id) BETWEEN 1 AND 20),
  CHECK (telegram_user_id NOT GLOB '*[^0-9]*'),
  CHECK (substr(telegram_user_id,1,1) <> '0')
);
