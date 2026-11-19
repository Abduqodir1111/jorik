-- Additive changes: rollback keeps current messages and drafts.
CREATE TABLE order_requests (
 key TEXT PRIMARY KEY,
 order_id TEXT NOT NULL,
 payload TEXT NOT NULL
);
ALTER TABLE accounts ADD COLUMN store_key TEXT;
UPDATE accounts SET store_key=upper(trim(name)) WHERE upper(trim(name)) IN ('STOREBOOKS','MANGASTORE');
ALTER TABLE conversations ADD COLUMN draft_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN draft_key TEXT NOT NULL DEFAULT '';
UPDATE orders SET data=json_set(data,'$.storeId',upper(trim(json_extract(data,'$.source'))))
 WHERE upper(trim(json_extract(data,'$.source'))) IN ('STOREBOOKS','MANGASTORE');
UPDATE orders SET data=json_set(data,'$.storeId',(
 SELECT a.store_key FROM conversations c JOIN accounts a ON a.id=c.account_id
 WHERE c.id=json_extract(orders.data,'$.conversationId')))
 WHERE json_extract(data,'$.storeId') IS NULL AND EXISTS (
 SELECT 1 FROM conversations c JOIN accounts a ON a.id=c.account_id
 WHERE c.id=json_extract(orders.data,'$.conversationId') AND a.store_key IS NOT NULL);
