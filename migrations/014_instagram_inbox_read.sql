-- Monotonic native read/reply boundary; separate table keeps older releases compatible.
CREATE TABLE instagram_inbox_reads (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  read_through TEXT NOT NULL
);

-- Reconcile stale counters from replies already confirmed before this release.
-- Queued/failed messages are not evidence; preserve arrivals newer than the reply.
INSERT INTO instagram_inbox_reads(conversation_id, read_through)
SELECT c.id, MAX(m.created_at) FROM conversations c
JOIN accounts a ON a.id=c.account_id
JOIN messages m ON m.conversation_id=c.id
WHERE a.platform='instagram' AND m.direction='out' AND m.status='sent'
GROUP BY c.id;
UPDATE conversations SET unread=MIN(unread, (
  SELECT COUNT(*) FROM messages m WHERE m.conversation_id=conversations.id
    AND m.direction='in' AND m.created_at>(SELECT read_through FROM instagram_inbox_reads WHERE conversation_id=conversations.id)
)) WHERE id IN (SELECT conversation_id FROM instagram_inbox_reads);

UPDATE conversations SET telegram_read_inbox_max_id=MAX(telegram_read_inbox_max_id,
  COALESCE((SELECT MAX(CAST(m.external_id AS INTEGER))-1 FROM messages m
    WHERE m.conversation_id=conversations.id AND m.direction='out' AND m.status='sent'
      AND m.external_id NOT GLOB '*[^0-9]*' AND CAST(m.external_id AS INTEGER)>0),-1))
WHERE account_id IN (SELECT id FROM accounts WHERE platform='telegram');
UPDATE conversations SET unread=MIN(unread, (SELECT COUNT(*) FROM messages m
  WHERE m.conversation_id=conversations.id AND m.direction='in'
    AND CAST(m.external_id AS INTEGER)>telegram_read_inbox_max_id))
WHERE account_id IN (SELECT id FROM accounts WHERE platform='telegram') AND telegram_read_inbox_max_id>=0;
