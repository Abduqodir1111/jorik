CREATE TABLE accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL,platform TEXT NOT NULL,adapter TEXT NOT NULL,mode TEXT NOT NULL,state TEXT NOT NULL,last_sync TEXT,error TEXT);
CREATE TABLE conversations(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),external_id TEXT NOT NULL,name TEXT NOT NULL,username TEXT NOT NULL DEFAULT '',unread INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,draft TEXT NOT NULL DEFAULT '',UNIQUE(account_id,external_id));
CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),external_id TEXT,direction TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,error TEXT,attachments TEXT NOT NULL DEFAULT '[]',UNIQUE(conversation_id,external_id));
CREATE INDEX messages_history ON messages(conversation_id,created_at);
CREATE TABLE outbox(id TEXT PRIMARY KEY,message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),conversation_id TEXT NOT NULL REFERENCES conversations(id),idempotency_key TEXT NOT NULL UNIQUE,state TEXT NOT NULL,available_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE owner(id INTEGER PRIMARY KEY CHECK(id=1),password_hash TEXT NOT NULL);
CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
