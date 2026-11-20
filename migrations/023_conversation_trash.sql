ALTER TABLE conversations ADD COLUMN deleted_at TEXT;
CREATE INDEX conversations_trash ON conversations(deleted_at, id) WHERE deleted_at IS NOT NULL;
ALTER TABLE conversations ADD COLUMN visibility_version INTEGER NOT NULL DEFAULT 0;
