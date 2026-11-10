ALTER TABLE archive_jobs ADD COLUMN source_key TEXT;
CREATE TABLE telegram_archive_media (
 account_id TEXT NOT NULL REFERENCES accounts(id),
 user_id TEXT NOT NULL,
 source_key TEXT NOT NULL,
 document_id TEXT NOT NULL,
 access_hash TEXT NOT NULL,
 file_reference BLOB NOT NULL,
 peer_id TEXT NOT NULL,
 message_id INTEGER NOT NULL,
 size INTEGER NOT NULL CHECK(size>0 AND size<=18874368),
 duration REAL NOT NULL CHECK(duration>0),
 width INTEGER NOT NULL CHECK(width>0),
 height INTEGER NOT NULL CHECK(height>0),
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(account_id,user_id,source_key)
);
