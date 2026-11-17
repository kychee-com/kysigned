-- 023_key_archive_cache.sql — F-10.8a (spec 0.77.0, #102, plan DD-84).
-- The key-archive proxy's memory: per public (domain, selector), the archive's
-- answer for a FOUND key, serialized once as text (a remembered answer comes back
-- byte-identical), when it was fetched (served for at most 24 hours after) and when
-- it was last looked up (forgotten after 7 idle days, or oldest-first beyond the
-- operator maximum). Read and written only by the web verifier's proxy; the
-- signing-time checks never use it. Public DNS facts only.
CREATE TABLE IF NOT EXISTS key_archive_cache (
  domain       TEXT NOT NULL,
  selector     TEXT NOT NULL,
  records      TEXT NOT NULL,
  fetched_at   TIMESTAMPTZ NOT NULL,
  last_hit_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (domain, selector)
);

-- Both forgetting rules (idle 7 days, oldest beyond the maximum) order or filter by it.
CREATE INDEX IF NOT EXISTS key_archive_cache_last_hit_idx ON key_archive_cache (last_hit_at);
