CREATE TABLE IF NOT EXISTS posts (
	guid TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	published_at TEXT NOT NULL,
	processed_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	post_guid TEXT REFERENCES posts(guid),
	kind TEXT NOT NULL CHECK (kind IN ('season_start', 'season_end', 'event')),
	name TEXT NOT NULL,
	starts_at TEXT NOT NULL,
	ends_at TEXT,
	raw_text TEXT,
	UNIQUE (kind, name, starts_at)
);

CREATE INDEX IF NOT EXISTS idx_events_starts ON events(starts_at);

CREATE TABLE IF NOT EXISTS kv (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

-- Manual seed: Season 6 start (Dexerto).
INSERT OR IGNORE INTO events (post_guid, kind, name, starts_at, ends_at, raw_text)
VALUES (NULL, 'season_start', 'Season 6', '2026-12-08T19:00:00Z', NULL, 'manual seed');
