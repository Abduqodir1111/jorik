CREATE TABLE instagram_identity(account_id TEXT PRIMARY KEY REFERENCES accounts(id),page_id TEXT NOT NULL,ig_id TEXT NOT NULL,username TEXT NOT NULL);
CREATE TABLE instagram_threads(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),recipient_id TEXT NOT NULL);
