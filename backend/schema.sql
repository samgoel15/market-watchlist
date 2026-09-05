-- Smart Market Watchlist — core schema
-- Design notes:
--   * price_snapshots is append-only (time series), never updated in place.
--     This is what makes "diff since last visit" and staleness detection possible.
--   * Every ticker maps to one benchmark, so relative-move math always has
--     something to compare against. Tickers with no clean sector fit fall
--     back to the market-wide index (see benchmark_id default logic in app code).
--   * last_seen_at lives on watchlist_members (per user, per watchlist), not
--     per device — this is what makes multi-device sync a timestamp
--     comparison instead of a sync protocol.

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE benchmarks (
  id            SERIAL PRIMARY KEY,
  symbol        TEXT UNIQUE NOT NULL,     -- e.g. 'NIFTY50', 'NIFTYBANK', 'NIFTYIT'
  name          TEXT NOT NULL
);

CREATE TABLE tickers (
  id            SERIAL PRIMARY KEY,
  symbol        TEXT UNIQUE NOT NULL,     -- e.g. 'RELIANCE', 'HDFCBANK'
  name          TEXT NOT NULL,
  sector        TEXT,                     -- nullable: some tickers won't cleanly map
  benchmark_id  INTEGER REFERENCES benchmarks(id),  -- which index to compare against
  listed_at     DATE                      -- used to detect "not enough history yet"
);

-- Append-only time series for both tickers and benchmarks.
-- is_benchmark lets us store both in one table and query them the same way.
CREATE TABLE price_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  ticker_id     INTEGER REFERENCES tickers(id),
  benchmark_id  INTEGER REFERENCES benchmarks(id),
  price         NUMERIC(12,4) NOT NULL,
  volume        BIGINT,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_ts     TIMESTAMPTZ,              -- timestamp the data provider gave us
  is_stale      BOOLEAN NOT NULL DEFAULT false,  -- set true if source_ts is old
  CHECK (
    (ticker_id IS NOT NULL AND benchmark_id IS NULL) OR
    (ticker_id IS NULL AND benchmark_id IS NOT NULL)
  )
);

CREATE INDEX idx_snapshots_ticker_time ON price_snapshots (ticker_id, captured_at DESC);
CREATE INDEX idx_snapshots_benchmark_time ON price_snapshots (benchmark_id, captured_at DESC);

CREATE TABLE watchlists (
  id            SERIAL PRIMARY KEY,
  owner_id      INTEGER REFERENCES users(id),
  name          TEXT NOT NULL DEFAULT 'My Watchlist',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE watchlist_items (
  watchlist_id  INTEGER REFERENCES watchlists(id),
  ticker_id     INTEGER REFERENCES tickers(id),
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (watchlist_id, ticker_id)
);

-- Per-user, per-watchlist "last seen" state — this is the whole multi-device
-- sync mechanism. No device table needed.
CREATE TABLE watchlist_members (
  watchlist_id  INTEGER REFERENCES watchlists(id),
  user_id       INTEGER REFERENCES users(id),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (watchlist_id, user_id)
);
