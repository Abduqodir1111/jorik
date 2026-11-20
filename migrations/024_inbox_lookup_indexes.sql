-- MAX(created_at) for incoming messages can seek a covering partial index,
-- without walking outgoing history and loading each row to check direction.
CREATE INDEX messages_incoming_latest
ON messages(conversation_id, created_at) WHERE direction='in';

-- Preview skips deleted messages without walking a deleted tail. SQLite's
-- implicit rowid suffix preserves the existing created_at DESC,rowid DESC tie.
CREATE INDEX messages_visible_latest
ON messages(conversation_id, created_at) WHERE deleted_at IS NULL;
