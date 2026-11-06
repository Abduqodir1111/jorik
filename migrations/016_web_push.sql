CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL DEFAULT 1 CHECK(owner_id=1),
  session_hash TEXT NOT NULL,
  subscription TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE push_jobs (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL REFERENCES push_subscriptions(endpoint) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL,
  PRIMARY KEY(message_id, endpoint)
);
