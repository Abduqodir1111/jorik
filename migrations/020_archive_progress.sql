ALTER TABLE archive_jobs ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE archive_jobs ADD COLUMN phase TEXT NOT NULL DEFAULT 'waiting';
ALTER TABLE archive_jobs ADD COLUMN percent INTEGER;
ALTER TABLE archive_jobs ADD COLUMN bytes_sent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE archive_jobs ADD COLUMN total_bytes INTEGER;
ALTER TABLE archive_jobs ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX archive_jobs_recent ON archive_jobs(created_at);
CREATE INDEX archive_jobs_message ON archive_jobs(message_id);
