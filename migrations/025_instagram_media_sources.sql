-- Provider URLs stay server-side; message attachments expose only local proxy URLs.
CREATE TABLE instagram_media_sources (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  media_index INTEGER NOT NULL CHECK(media_index BETWEEN 0 AND 99),
  kind TEXT NOT NULL CHECK(kind IN ('image','video','voice')),
  url TEXT,
  media_id TEXT,
  PRIMARY KEY(message_id,media_index)
);
