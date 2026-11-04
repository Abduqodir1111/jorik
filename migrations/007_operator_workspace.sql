ALTER TABLE conversations ADD COLUMN stage TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN reply_to_id TEXT;
ALTER TABLE messages ADD COLUMN read_at TEXT;
CREATE TABLE uploads (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 name TEXT NOT NULL, mime TEXT NOT NULL, bytes BLOB NOT NULL, created_at TEXT NOT NULL
);
