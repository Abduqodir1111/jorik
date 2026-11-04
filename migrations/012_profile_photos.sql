CREATE TABLE profile_photos (
 conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
 bytes BLOB,
 checked_at INTEGER NOT NULL
);
