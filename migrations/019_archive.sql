CREATE TABLE archive_jobs (
 id TEXT PRIMARY KEY,
 idempotency_key TEXT NOT NULL UNIQUE,
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 entry_id TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'preparing',
 file TEXT,
 size INTEGER,
 duration REAL,
 width INTEGER,
 height INTEGER,
 message_id TEXT REFERENCES messages(id),
 error TEXT,
 created_at INTEGER NOT NULL
);
CREATE TABLE archive_links (
 path TEXT PRIMARY KEY,
 url TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
