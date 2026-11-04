CREATE TABLE telegram_sessions(account_id TEXT PRIMARY KEY REFERENCES accounts(id),ciphertext TEXT NOT NULL);
CREATE TABLE telegram_peers(account_id TEXT NOT NULL REFERENCES accounts(id),user_id TEXT NOT NULL,access_hash TEXT NOT NULL,name TEXT NOT NULL,username TEXT NOT NULL,PRIMARY KEY(account_id,user_id));
CREATE TABLE telegram_state(account_id TEXT PRIMARY KEY REFERENCES accounts(id),state_json TEXT NOT NULL);
ALTER TABLE outbox ADD COLUMN provider_random_id TEXT;
CREATE INDEX outbox_random_id ON outbox(provider_random_id);
