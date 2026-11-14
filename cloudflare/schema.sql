-- Free Jensen petition: D1 schema.
-- Raw IPs are NEVER stored. ip_hash = HMAC-SHA256(secret, IPv4 or IPv6 /64).

CREATE TABLE IF NOT EXISTS signatures (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash     TEXT    NOT NULL,
  country     TEXT    NOT NULL CHECK (length(country) = 2),
  reason      TEXT             CHECK (reason IS NULL OR length(reason) <= 280),
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sig_ip_time ON signatures (ip_hash, created_at);

CREATE TABLE IF NOT EXISTS country_counts (
  country TEXT PRIMARY KEY,
  n       INTEGER NOT NULL
);

-- Single row: running total + a version that bumps on every signature,
-- so live listeners can detect changes by reading one row.
CREATE TABLE IF NOT EXISTS meta (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  total      INTEGER NOT NULL,
  version    INTEGER NOT NULL,
  updated_at INTEGER
);
INSERT OR IGNORE INTO meta (id, total, version, updated_at) VALUES (1, 0, 0, NULL);

-- Counts are maintained by the database itself, in the same transaction as
-- the insert, so they can never drift from the signatures table.
CREATE TRIGGER IF NOT EXISTS sig_after_insert AFTER INSERT ON signatures
BEGIN
  INSERT INTO country_counts (country, n) VALUES (NEW.country, 1)
    ON CONFLICT (country) DO UPDATE SET n = n + 1;
  UPDATE meta SET total = total + 1, version = version + 1, updated_at = NEW.created_at WHERE id = 1;
END;
