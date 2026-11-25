-- Run once on databases created before 2026-11-23 (fresh databases get these from schema.sql).
-- ALTER TABLE ADD COLUMN is not idempotent: a second run fails with "duplicate column name".
ALTER TABLE posts ADD COLUMN url TEXT;
ALTER TABLE events ADD COLUMN summary TEXT;
ALTER TABLE events ADD COLUMN facts TEXT;
ALTER TABLE events ADD COLUMN source_url TEXT;
ALTER TABLE events ADD COLUMN source_title TEXT;
-- Old Steam-feed ETag is no longer used.
DELETE FROM kv WHERE key = 'feed_etag';
