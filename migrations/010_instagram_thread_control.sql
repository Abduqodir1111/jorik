CREATE TABLE instagram_thread_control (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
  standby INTEGER NOT NULL,
  event_timestamp INTEGER NOT NULL
);
