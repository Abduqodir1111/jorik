CREATE TABLE meta_webhook_inbox (
  digest TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  available_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX meta_webhook_pending ON meta_webhook_inbox(processed_at,available_at);
ALTER TABLE messages ADD COLUMN instagram_key TEXT;
CREATE UNIQUE INDEX instagram_message_key ON messages(conversation_id,instagram_key) WHERE instagram_key IS NOT NULL;
