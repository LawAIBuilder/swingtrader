-- Bounce Trader schema (Phase 1A + PR 1 entry semantics)
-- Idempotent: safe to re-apply against an existing project.
--
-- Everything lives in the `bounce_trader` schema so it does not collide with
-- whatever else is on the Supabase project. The schema is exposed to PostgREST
-- so the Supabase JS client can target it via { db: { schema: 'bounce_trader' } }.

CREATE SCHEMA IF NOT EXISTS bounce_trader;

-- Expose the schema via PostgREST. Idempotent: the SET assignment overwrites
-- whatever value was there, and we always include the standard schemas plus ours.
ALTER ROLE authenticator SET pgrst.db_schemas = 'public,graphql_public,bounce_trader';
NOTIFY pgrst, 'reload config';

GRANT USAGE ON SCHEMA bounce_trader TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA bounce_trader
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA bounce_trader
  GRANT ALL ON SEQUENCES TO service_role;

CREATE TABLE IF NOT EXISTS bounce_trader.candidates (
  id BIGSERIAL PRIMARY KEY,
  ticker TEXT NOT NULL,
  screen_date DATE NOT NULL,
  screen_source TEXT NOT NULL CHECK (screen_source IN ('screen_a', 'screen_b')),
  pct_change NUMERIC,
  volume BIGINT,
  rel_volume NUMERIC,
  market_cap BIGINT,
  price NUMERIC,
  prev_close NUMERIC,
  sector TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (ticker, screen_date, screen_source)
);

CREATE TABLE IF NOT EXISTS bounce_trader.pre_flags (
  candidate_id BIGINT PRIMARY KEY REFERENCES bounce_trader.candidates(id) ON DELETE CASCADE,
  has_recent_offering BOOLEAN,
  earnings_within_5d BOOLEAN,
  dividend_suspended BOOLEAN,
  liquidity_ok BOOLEAN,
  wash_sale_lockout BOOLEAN,
  -- PR 3: skip the candidate entirely if a split/reverse-split/special dividend
  -- falls within [signal_date - 30d, signal_date + 10d]. Phase 1A is skip-first;
  -- back-adjustment of historical bars is intentionally deferred.
  corp_action_in_window BOOLEAN NOT NULL DEFAULT FALSE,
  -- PR 3: explicit provenance for each detection so 'keyword fallback' rows are
  -- never confused with real provider answers. earnings_source: 'keyword_fallback'
  -- (default) or 'finnhub' (when FINNHUB_API_KEY is configured). offering_source:
  -- 'none', 'keyword' (news regex), or 'edgar' (424B/FWP/S-1/S-3 within lookback).
  earnings_source TEXT NOT NULL DEFAULT 'keyword_fallback',
  offering_source TEXT NOT NULL DEFAULT 'none',
  -- Structured list of reasons that drove auto_disposition. Stored as JSONB so
  -- the dashboard can filter without re-deriving from the booleans.
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  auto_disposition TEXT CHECK (auto_disposition IN ('AVOID', 'BLACKOUT', 'OK_FOR_AI', 'SKIP')),
  flags_run_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bounce_trader.catalysts (
  candidate_id BIGINT PRIMARY KEY REFERENCES bounce_trader.candidates(id) ON DELETE CASCADE,
  evidence_json JSONB NOT NULL,
  evidence_tokens INT,
  fetched_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bounce_trader.analyses (
  id BIGSERIAL PRIMARY KEY,
  candidate_id BIGINT REFERENCES bounce_trader.candidates(id) ON DELETE CASCADE,
  prompt_version TEXT NOT NULL,
  model_name TEXT NOT NULL,
  ai_tier TEXT CHECK (ai_tier IN ('BUY', 'PASS', 'AVOID')),
  thesis TEXT,
  selloff_type TEXT,
  day_of_drop INT,
  risk_flags JSONB,
  raw_response TEXT NOT NULL,
  schema_valid BOOLEAN NOT NULL,
  retry_count INT DEFAULT 0,
  tokens_used INT,
  -- PR 5: split totals so cost can be computed at query time. Older rows
  -- written before this column existed will have NULL here; the cost view
  -- below treats NULLs as 0 input / 0 output.
  input_tokens INT,
  output_tokens INT,
  estimated_cost_usd NUMERIC,
  analyzed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Idempotent migration for installs that have an older `analyses` table.
ALTER TABLE bounce_trader.analyses
  ADD COLUMN IF NOT EXISTS input_tokens INT;
ALTER TABLE bounce_trader.analyses
  ADD COLUMN IF NOT EXISTS output_tokens INT;
ALTER TABLE bounce_trader.analyses
  ADD COLUMN IF NOT EXISTS estimated_cost_usd NUMERIC;

CREATE TABLE IF NOT EXISTS bounce_trader.paper_trades (
  id BIGSERIAL PRIMARY KEY,
  candidate_id BIGINT NOT NULL REFERENCES bounce_trader.candidates(id) ON DELETE CASCADE,
  analysis_id BIGINT REFERENCES bounce_trader.analyses(id) ON DELETE SET NULL,
  effective_tier TEXT NOT NULL,
  ticker TEXT NOT NULL,
  screen_source TEXT NOT NULL,
  prompt_version TEXT,
  entry_mode TEXT NOT NULL DEFAULT 'next_day_open' CHECK (entry_mode IN ('signal_close', 'next_day_open')),
  signal_date DATE NOT NULL,
  entry_date DATE NOT NULL,
  entry_price NUMERIC,
  atr14 NUMERIC NOT NULL,
  signal_day_low NUMERIC NOT NULL,
  stop_price NUMERIC,
  target_price NUMERIC,
  modeled_slippage_bps INT NOT NULL,
  liquidity_bucket TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_entry' CHECK (status IN ('pending_entry', 'open', 'stopped', 'target_hit', 'time_closed', 'corp_action')),
  exit_date DATE,
  exit_price NUMERIC,
  exit_reason TEXT,
  had_ambiguous_day BOOLEAN DEFAULT FALSE,
  pnl_pct_gross NUMERIC,
  pnl_pct_net NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (
    status = 'pending_entry'
    OR (entry_price IS NOT NULL AND stop_price IS NOT NULL AND target_price IS NOT NULL)
  ),
  UNIQUE (candidate_id)
);

CREATE TABLE IF NOT EXISTS bounce_trader.trade_progression (
  paper_trade_id BIGINT REFERENCES bounce_trader.paper_trades(id) ON DELETE CASCADE,
  day_number INT NOT NULL,
  date DATE NOT NULL,
  open_price NUMERIC NOT NULL,
  high_price NUMERIC NOT NULL,
  low_price NUMERIC NOT NULL,
  close_price NUMERIC NOT NULL,
  touched_stop BOOLEAN NOT NULL,
  touched_target BOOLEAN NOT NULL,
  is_ambiguous BOOLEAN NOT NULL,
  pnl_pct_gross NUMERIC NOT NULL,
  pnl_pct_net NUMERIC NOT NULL,
  PRIMARY KEY (paper_trade_id, day_number),
  UNIQUE (paper_trade_id, date)
);

CREATE TABLE IF NOT EXISTS bounce_trader.run_logs (
  id BIGSERIAL PRIMARY KEY,
  run_date DATE NOT NULL,
  job_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed', 'skipped')),
  details JSONB,
  duration_ms INT,
  forced BOOLEAN NOT NULL DEFAULT FALSE,
  ran_at TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

-- PR 2 run lock: at most one row per (run_date, job_name) may be in 'running'
-- state. Insert against this constraint = atomic lock acquisition. Completed
-- runs (success/partial/failed/skipped) coexist with future running rows, so
-- the index is partial.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_run_logs_running_per_jobdate
  ON bounce_trader.run_logs(run_date, job_name)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS bounce_trader.wash_sale_lockout (
  ticker TEXT NOT NULL,
  lockout_until DATE NOT NULL,
  reason TEXT,
  PRIMARY KEY (ticker, lockout_until)
);

-- PR 4D: durable daily summaries. Previously only emailed (or written to
-- /tmp on Vercel, which is ephemeral). Now persisted so the dashboard can
-- show recent summaries and re-render them later.
CREATE TABLE IF NOT EXISTS bounce_trader.daily_summaries (
  id BIGSERIAL PRIMARY KEY,
  run_date DATE NOT NULL,
  markdown TEXT NOT NULL,
  emailed BOOLEAN NOT NULL DEFAULT FALSE,
  email_reason TEXT,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (run_date)
);

-- Idempotent UNIQUE for installs that created daily_summaries before the
-- inline UNIQUE existed. The summary job uses upsert(onConflict='run_date'),
-- which fails on tables without this constraint. We only create the standalone
-- index if the table-level UNIQUE constraint isn't already there; otherwise we
-- would create a duplicate index that supabase's performance advisor flags.
DO $daily_summaries_uniq$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'bounce_trader'
      AND t.relname = 'daily_summaries'
      AND c.contype = 'u'
      AND c.conname = 'daily_summaries_run_date_key'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS uniq_daily_summaries_run_date ON bounce_trader.daily_summaries(run_date)';
  ELSE
    EXECUTE 'DROP INDEX IF EXISTS bounce_trader.uniq_daily_summaries_run_date';
  END IF;
END
$daily_summaries_uniq$;

-- PR 6: baseline trades. Same outcome lifecycle as paper_trades but stored
-- separately so the headline dashboard isn't polluted with synthetic comparison
-- rows. Each candidate seeds one baseline row per kind:
--   buy_all     - bought regardless of pre-flag or AI tier
--   rules_only  - bought when pre-flag did not reject (no AI gate)
-- spy/sector benchmarks are deferred until a per-candidate benchmark fetch
-- exists; the discriminator string is open so that future kinds can be added
-- without altering this table.
CREATE TABLE IF NOT EXISTS bounce_trader.baseline_trades (
  id BIGSERIAL PRIMARY KEY,
  candidate_id BIGINT NOT NULL REFERENCES bounce_trader.candidates(id) ON DELETE CASCADE,
  baseline_kind TEXT NOT NULL,
  ticker TEXT NOT NULL,
  signal_date DATE NOT NULL,
  entry_date DATE NOT NULL,
  entry_price NUMERIC,
  atr14 NUMERIC NOT NULL,
  signal_day_low NUMERIC NOT NULL,
  stop_price NUMERIC,
  target_price NUMERIC,
  modeled_slippage_bps INT NOT NULL,
  liquidity_bucket TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_entry' CHECK (status IN ('pending_entry', 'open', 'stopped', 'target_hit', 'time_closed', 'corp_action')),
  exit_date DATE,
  exit_price NUMERIC,
  exit_reason TEXT,
  had_ambiguous_day BOOLEAN DEFAULT FALSE,
  pnl_pct_gross NUMERIC,
  pnl_pct_net NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (candidate_id, baseline_kind)
);

CREATE TABLE IF NOT EXISTS bounce_trader.baseline_progression (
  baseline_trade_id BIGINT REFERENCES bounce_trader.baseline_trades(id) ON DELETE CASCADE,
  day_number INT NOT NULL,
  date DATE NOT NULL,
  open_price NUMERIC NOT NULL,
  high_price NUMERIC NOT NULL,
  low_price NUMERIC NOT NULL,
  close_price NUMERIC NOT NULL,
  touched_stop BOOLEAN NOT NULL,
  touched_target BOOLEAN NOT NULL,
  is_ambiguous BOOLEAN NOT NULL,
  pnl_pct_gross NUMERIC NOT NULL,
  pnl_pct_net NUMERIC NOT NULL,
  PRIMARY KEY (baseline_trade_id, day_number),
  UNIQUE (baseline_trade_id, date)
);

-- PR 7: intraday paper mode. Designed to run alongside the EOD swing system
-- without contaminating it. There is intentionally no foreign key from
-- intraday_paper_trades to candidates/paper_trades; intraday signals come
-- from a different decision loop and may not have any swing-screen origin.
--
-- Live broker execution does NOT exist in this codebase. This table is for
-- forward simulation only, with quote-aware slippage and rejection of wide
-- spreads.
CREATE TABLE IF NOT EXISTS bounce_trader.intraday_signals (
  id BIGSERIAL PRIMARY KEY,
  ticker TEXT NOT NULL,
  signal_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL,
  bid NUMERIC,
  ask NUMERIC,
  last_price NUMERIC,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bounce_trader.intraday_paper_trades (
  id BIGSERIAL PRIMARY KEY,
  signal_id BIGINT REFERENCES bounce_trader.intraday_signals(id) ON DELETE SET NULL,
  ticker TEXT NOT NULL,
  entered_at TIMESTAMPTZ NOT NULL,
  entry_price NUMERIC NOT NULL,
  stop_price NUMERIC NOT NULL,
  target_price NUMERIC NOT NULL,
  modeled_slippage_bps INT NOT NULL,
  spread_bps_at_entry INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'stopped', 'target_hit', 'time_closed', 'rejected_wide_spread')),
  exited_at TIMESTAMPTZ,
  exit_price NUMERIC,
  exit_reason TEXT,
  max_adverse_excursion_bps INT,
  max_favorable_excursion_bps INT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bounce_trader.intraday_progression (
  intraday_trade_id BIGINT REFERENCES bounce_trader.intraday_paper_trades(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL,
  bid NUMERIC,
  ask NUMERIC,
  last_price NUMERIC,
  spread_bps INT,
  pnl_pct_net NUMERIC,
  touched_stop BOOLEAN,
  touched_target BOOLEAN,
  PRIMARY KEY (intraday_trade_id, observed_at)
);

CREATE INDEX IF NOT EXISTS idx_candidates_screen_date ON bounce_trader.candidates(screen_date DESC);
CREATE INDEX IF NOT EXISTS idx_candidates_ticker_date ON bounce_trader.candidates(ticker, screen_date DESC);
CREATE INDEX IF NOT EXISTS idx_analyses_candidate_id ON bounce_trader.analyses(candidate_id);
CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON bounce_trader.paper_trades(status);
CREATE INDEX IF NOT EXISTS idx_paper_trades_ticker ON bounce_trader.paper_trades(ticker);
CREATE INDEX IF NOT EXISTS idx_paper_trades_exit_date ON bounce_trader.paper_trades(exit_date DESC);
CREATE INDEX IF NOT EXISTS idx_progression_date ON bounce_trader.trade_progression(date DESC);
CREATE INDEX IF NOT EXISTS idx_run_logs_ran_at ON bounce_trader.run_logs(ran_at DESC);
CREATE INDEX IF NOT EXISTS idx_daily_summaries_run_date ON bounce_trader.daily_summaries(run_date DESC);
CREATE INDEX IF NOT EXISTS idx_baseline_trades_kind_status ON bounce_trader.baseline_trades(baseline_kind, status);
CREATE INDEX IF NOT EXISTS idx_baseline_trades_signal_date ON bounce_trader.baseline_trades(signal_date DESC);
CREATE INDEX IF NOT EXISTS idx_baseline_progression_date ON bounce_trader.baseline_progression(date DESC);
CREATE INDEX IF NOT EXISTS idx_intraday_signals_ticker_time ON bounce_trader.intraday_signals(ticker, signal_at DESC);
CREATE INDEX IF NOT EXISTS idx_intraday_paper_trades_status ON bounce_trader.intraday_paper_trades(status);
CREATE INDEX IF NOT EXISTS idx_intraday_paper_trades_entered_at ON bounce_trader.intraday_paper_trades(entered_at DESC);
-- Covering indexes for foreign keys flagged by supabase advisor. Without these,
-- DELETE on the parent table forces a sequential scan of the referencing table
-- to enforce the ON DELETE action; trivial today but bites once data lands.
CREATE INDEX IF NOT EXISTS idx_intraday_paper_trades_signal_id ON bounce_trader.intraday_paper_trades(signal_id);
CREATE INDEX IF NOT EXISTS idx_paper_trades_analysis_id ON bounce_trader.paper_trades(analysis_id);
CREATE INDEX IF NOT EXISTS idx_intraday_progression_observed ON bounce_trader.intraday_progression(observed_at DESC);

-- At most one open intraday paper trade per ticker. The intraday tick job
-- already does a "check no open then insert" sequence, but that is racy if
-- the run-lock is ever bypassed (e.g. an external scheduler retries through
-- the 409). The partial unique index guarantees the invariant at the
-- database level so a duplicate insert fails with 23505 instead of producing
-- two open positions.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_intraday_open_per_ticker
  ON bounce_trader.intraday_paper_trades(ticker)
  WHERE status = 'open';

-- PR 8: broker paper execution. Every order this app sends to a broker is
-- recorded BEFORE submission with a unique idempotency_key derived from the
-- internal trade context. The broker's returned id (broker_order_id) is
-- written back on success. If the broker call fails or times out, we keep
-- the row with status='submission_failed' so reconciliation can heal it on
-- the next pass instead of double-submitting.
--
-- There is NO 'live' broker mode in this schema or codebase. Even a deploy
-- with BROKER_MODE=live would simply have no client implementation to
-- dispatch to.
CREATE TABLE IF NOT EXISTS bounce_trader.broker_orders (
  id BIGSERIAL PRIMARY KEY,
  -- Stable, idempotent key set by the application BEFORE submission. Used as
  -- the broker's client_order_id wherever the API supports one (Alpaca's
  -- client_order_id is exactly this).
  idempotency_key TEXT NOT NULL UNIQUE,
  paper_trade_id BIGINT REFERENCES bounce_trader.paper_trades(id) ON DELETE SET NULL,
  intraday_trade_id BIGINT REFERENCES bounce_trader.intraday_paper_trades(id) ON DELETE SET NULL,
  broker TEXT NOT NULL CHECK (broker IN ('alpaca_paper', 'mock')),
  ticker TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  order_type TEXT NOT NULL CHECK (order_type IN ('market', 'limit', 'stop', 'bracket')),
  quantity NUMERIC NOT NULL,
  limit_price NUMERIC,
  stop_price NUMERIC,
  target_price NUMERIC,
  time_in_force TEXT,
  status TEXT NOT NULL DEFAULT 'pending_submit' CHECK (status IN (
    'pending_submit', 'submitted', 'partially_filled', 'filled',
    'canceled', 'rejected', 'expired', 'submission_failed', 'unknown'
  )),
  broker_order_id TEXT,
  filled_quantity NUMERIC NOT NULL DEFAULT 0,
  avg_fill_price NUMERIC,
  last_error TEXT,
  reconciliation_status TEXT NOT NULL DEFAULT 'pending' CHECK (reconciliation_status IN (
    'pending', 'matched', 'mismatch', 'broker_unknown', 'orphan_local'
  )),
  reconciled_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  filled_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bounce_trader.broker_positions (
  id BIGSERIAL PRIMARY KEY,
  broker TEXT NOT NULL CHECK (broker IN ('alpaca_paper', 'mock')),
  ticker TEXT NOT NULL,
  quantity NUMERIC NOT NULL,
  avg_entry_price NUMERIC,
  market_value NUMERIC,
  unrealized_pl NUMERIC,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Broker-side snapshot id so multiple consecutive reconciliations can
  -- reference the same broker pull cleanly.
  snapshot_id TEXT,
  UNIQUE (broker, ticker, observed_at)
);

CREATE INDEX IF NOT EXISTS idx_broker_orders_status ON bounce_trader.broker_orders(status);
CREATE INDEX IF NOT EXISTS idx_broker_orders_paper_trade ON bounce_trader.broker_orders(paper_trade_id);
CREATE INDEX IF NOT EXISTS idx_broker_orders_intraday_trade ON bounce_trader.broker_orders(intraday_trade_id);
CREATE INDEX IF NOT EXISTS idx_broker_orders_recon ON bounce_trader.broker_orders(reconciliation_status);
CREATE INDEX IF NOT EXISTS idx_broker_positions_observed ON bounce_trader.broker_positions(observed_at DESC);

-- RLS: deny-by-default on every table. Service role bypasses RLS by Supabase
-- convention. Anon/authenticated can only read what we explicitly expose
-- through dashboard views below.
ALTER TABLE bounce_trader.candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE bounce_trader.pre_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE bounce_trader.catalysts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bounce_trader.analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE bounce_trader.paper_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE bounce_trader.trade_progression ENABLE ROW LEVEL SECURITY;
ALTER TABLE bounce_trader.run_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE bounce_trader.wash_sale_lockout ENABLE ROW LEVEL SECURITY;
ALTER TABLE bounce_trader.daily_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE bounce_trader.baseline_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE bounce_trader.baseline_progression ENABLE ROW LEVEL SECURITY;
ALTER TABLE bounce_trader.intraday_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE bounce_trader.intraday_paper_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE bounce_trader.intraday_progression ENABLE ROW LEVEL SECURITY;
ALTER TABLE bounce_trader.broker_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE bounce_trader.broker_positions ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE VIEW bounce_trader.v_dashboard_today_candidates AS
WITH latest AS (
  SELECT MAX(screen_date) AS screen_date FROM bounce_trader.candidates
), latest_analysis AS (
  SELECT DISTINCT ON (candidate_id) *
  FROM bounce_trader.analyses
  ORDER BY candidate_id, analyzed_at DESC
)
SELECT
  c.id,
  c.ticker,
  c.screen_date,
  c.screen_source,
  c.pct_change,
  c.volume,
  c.rel_volume,
  c.market_cap,
  c.price,
  c.prev_close,
  c.sector,
  pf.auto_disposition,
  pf.has_recent_offering,
  pf.earnings_within_5d,
  a.ai_tier,
  a.thesis,
  a.selloff_type,
  a.risk_flags,
  pt.effective_tier,
  pt.entry_mode,
  pt.status AS trade_status,
  pt.stop_price,
  pt.target_price
FROM bounce_trader.candidates c
JOIN latest l ON c.screen_date = l.screen_date
LEFT JOIN bounce_trader.pre_flags pf ON pf.candidate_id = c.id
LEFT JOIN latest_analysis a ON a.candidate_id = c.id
LEFT JOIN bounce_trader.paper_trades pt ON pt.candidate_id = c.id
ORDER BY c.screen_source, c.ticker;

CREATE OR REPLACE VIEW bounce_trader.v_dashboard_open_trades AS
SELECT
  pt.*,
  COALESCE(MAX(tp.day_number), 0) AS days_open,
  MAX(tp.pnl_pct_net) FILTER (WHERE tp.day_number = (
    SELECT MAX(tp2.day_number) FROM bounce_trader.trade_progression tp2 WHERE tp2.paper_trade_id = pt.id
  )) AS latest_pnl_net
FROM bounce_trader.paper_trades pt
LEFT JOIN bounce_trader.trade_progression tp ON tp.paper_trade_id = pt.id
WHERE pt.status = 'open'
GROUP BY pt.id
ORDER BY pt.entry_date ASC, pt.ticker ASC;

CREATE OR REPLACE VIEW bounce_trader.v_dashboard_recent_closed_trades AS
SELECT *
FROM bounce_trader.paper_trades
WHERE status IN ('stopped', 'target_hit', 'time_closed', 'corp_action')
ORDER BY exit_date DESC NULLS LAST, id DESC
LIMIT 100;

CREATE OR REPLACE VIEW bounce_trader.v_basic_stats_by_tier AS
SELECT
  effective_tier AS group_key,
  COUNT(*)::INT AS closed_trades,
  AVG(CASE WHEN pnl_pct_net > 0 THEN 1.0 ELSE 0.0 END) AS win_rate,
  AVG(pnl_pct_net) AS avg_pnl_net,
  AVG(pnl_pct_gross) AS avg_pnl_gross,
  AVG(CASE WHEN had_ambiguous_day THEN 1.0 ELSE 0.0 END) AS ambiguous_rate
FROM bounce_trader.paper_trades
WHERE status IN ('stopped', 'target_hit', 'time_closed', 'corp_action')
  AND pnl_pct_net IS NOT NULL
GROUP BY effective_tier;

CREATE OR REPLACE VIEW bounce_trader.v_basic_stats_by_screen AS
SELECT
  screen_source AS group_key,
  COUNT(*)::INT AS closed_trades,
  AVG(CASE WHEN pnl_pct_net > 0 THEN 1.0 ELSE 0.0 END) AS win_rate,
  AVG(pnl_pct_net) AS avg_pnl_net,
  AVG(pnl_pct_gross) AS avg_pnl_gross,
  AVG(CASE WHEN had_ambiguous_day THEN 1.0 ELSE 0.0 END) AS ambiguous_rate
FROM bounce_trader.paper_trades
WHERE status IN ('stopped', 'target_hit', 'time_closed', 'corp_action')
  AND pnl_pct_net IS NOT NULL
GROUP BY screen_source;

CREATE OR REPLACE VIEW bounce_trader.v_ai_cost_daily AS
SELECT
  DATE(analyzed_at) AS day,
  model_name,
  prompt_version,
  COUNT(*)::INT AS calls,
  COALESCE(SUM(input_tokens), 0)::INT AS input_tokens,
  COALESCE(SUM(output_tokens), 0)::INT AS output_tokens,
  COALESCE(SUM(estimated_cost_usd), 0)::NUMERIC AS cost_usd,
  AVG(CASE WHEN schema_valid THEN 1.0 ELSE 0.0 END) AS schema_valid_rate
FROM bounce_trader.analyses
WHERE model_name NOT IN ('mock-ai', 'preflag-rules')
GROUP BY DATE(analyzed_at), model_name, prompt_version
ORDER BY day DESC, model_name, prompt_version;

CREATE OR REPLACE VIEW bounce_trader.v_basic_stats_by_prompt AS
SELECT
  pt.prompt_version AS group_key,
  COUNT(*)::INT AS closed_trades,
  AVG(CASE WHEN pt.pnl_pct_net > 0 THEN 1.0 ELSE 0.0 END) AS win_rate,
  AVG(pt.pnl_pct_net) AS avg_pnl_net,
  AVG(pt.pnl_pct_gross) AS avg_pnl_gross,
  AVG(CASE WHEN pt.had_ambiguous_day THEN 1.0 ELSE 0.0 END) AS ambiguous_rate
FROM bounce_trader.paper_trades pt
WHERE pt.status IN ('stopped', 'target_hit', 'time_closed', 'corp_action')
  AND pt.pnl_pct_net IS NOT NULL
GROUP BY pt.prompt_version;

-- PR 6: analytics. These are read-only aggregations, RLS-anonymously
-- readable, intended for the /analytics page. None of them join into
-- catalysts or wash_sale_lockout (which remain admin-only).

CREATE OR REPLACE VIEW bounce_trader.v_basic_stats_by_selloff AS
SELECT
  COALESCE(a.selloff_type, 'unknown') AS group_key,
  COUNT(pt.*)::INT AS closed_trades,
  AVG(CASE WHEN pt.pnl_pct_net > 0 THEN 1.0 ELSE 0.0 END) AS win_rate,
  AVG(pt.pnl_pct_net) AS avg_pnl_net,
  AVG(pt.pnl_pct_gross) AS avg_pnl_gross,
  AVG(CASE WHEN pt.had_ambiguous_day THEN 1.0 ELSE 0.0 END) AS ambiguous_rate
FROM bounce_trader.paper_trades pt
LEFT JOIN bounce_trader.analyses a ON a.id = pt.analysis_id
WHERE pt.status IN ('stopped', 'target_hit', 'time_closed', 'corp_action')
  AND pt.pnl_pct_net IS NOT NULL
GROUP BY COALESCE(a.selloff_type, 'unknown');

CREATE OR REPLACE VIEW bounce_trader.v_basic_stats_by_sector AS
SELECT
  COALESCE(c.sector, 'unknown') AS group_key,
  COUNT(pt.*)::INT AS closed_trades,
  AVG(CASE WHEN pt.pnl_pct_net > 0 THEN 1.0 ELSE 0.0 END) AS win_rate,
  AVG(pt.pnl_pct_net) AS avg_pnl_net,
  AVG(pt.pnl_pct_gross) AS avg_pnl_gross,
  AVG(CASE WHEN pt.had_ambiguous_day THEN 1.0 ELSE 0.0 END) AS ambiguous_rate
FROM bounce_trader.paper_trades pt
JOIN bounce_trader.candidates c ON c.id = pt.candidate_id
WHERE pt.status IN ('stopped', 'target_hit', 'time_closed', 'corp_action')
  AND pt.pnl_pct_net IS NOT NULL
GROUP BY COALESCE(c.sector, 'unknown');

CREATE OR REPLACE VIEW bounce_trader.v_basic_stats_by_disposition AS
SELECT
  COALESCE(pf.auto_disposition, 'unknown') AS group_key,
  COUNT(pt.*)::INT AS closed_trades,
  AVG(CASE WHEN pt.pnl_pct_net > 0 THEN 1.0 ELSE 0.0 END) AS win_rate,
  AVG(pt.pnl_pct_net) AS avg_pnl_net,
  AVG(pt.pnl_pct_gross) AS avg_pnl_gross,
  AVG(CASE WHEN pt.had_ambiguous_day THEN 1.0 ELSE 0.0 END) AS ambiguous_rate
FROM bounce_trader.paper_trades pt
JOIN bounce_trader.candidates c ON c.id = pt.candidate_id
LEFT JOIN bounce_trader.pre_flags pf ON pf.candidate_id = c.id
WHERE pt.status IN ('stopped', 'target_hit', 'time_closed', 'corp_action')
  AND pt.pnl_pct_net IS NOT NULL
GROUP BY COALESCE(pf.auto_disposition, 'unknown');

CREATE OR REPLACE VIEW bounce_trader.v_candidates_per_day AS
SELECT
  screen_date AS day,
  COUNT(*)::INT AS candidates,
  COUNT(DISTINCT ticker)::INT AS unique_tickers
FROM bounce_trader.candidates
GROUP BY screen_date
ORDER BY screen_date DESC
LIMIT 90;

CREATE OR REPLACE VIEW bounce_trader.v_pnl_per_day AS
SELECT
  exit_date AS day,
  COUNT(*)::INT AS closed,
  SUM(pnl_pct_net) AS sum_pnl_net,
  AVG(pnl_pct_net) AS avg_pnl_net,
  AVG(CASE WHEN pnl_pct_net > 0 THEN 1.0 ELSE 0.0 END) AS win_rate
FROM bounce_trader.paper_trades
WHERE exit_date IS NOT NULL
  AND pnl_pct_net IS NOT NULL
GROUP BY exit_date
ORDER BY exit_date DESC
LIMIT 90;

CREATE OR REPLACE VIEW bounce_trader.v_recent_intraday_trades AS
SELECT
  pt.id,
  pt.ticker,
  pt.entered_at,
  pt.entry_price,
  pt.stop_price,
  pt.target_price,
  pt.modeled_slippage_bps,
  pt.spread_bps_at_entry,
  pt.status,
  pt.exited_at,
  pt.exit_price,
  pt.exit_reason,
  pt.max_adverse_excursion_bps,
  pt.max_favorable_excursion_bps,
  pt.notes,
  s.source AS signal_source
FROM bounce_trader.intraday_paper_trades pt
LEFT JOIN bounce_trader.intraday_signals s ON s.id = pt.signal_id
ORDER BY pt.entered_at DESC
LIMIT 100;

CREATE OR REPLACE VIEW bounce_trader.v_baseline_stats AS
SELECT
  baseline_kind AS group_key,
  COUNT(*)::INT AS closed_trades,
  AVG(CASE WHEN pnl_pct_net > 0 THEN 1.0 ELSE 0.0 END) AS win_rate,
  AVG(pnl_pct_net) AS avg_pnl_net,
  AVG(pnl_pct_gross) AS avg_pnl_gross,
  AVG(CASE WHEN had_ambiguous_day THEN 1.0 ELSE 0.0 END) AS ambiguous_rate
FROM bounce_trader.baseline_trades
WHERE status IN ('stopped', 'target_hit', 'time_closed', 'corp_action')
  AND pnl_pct_net IS NOT NULL
GROUP BY baseline_kind;

CREATE OR REPLACE VIEW bounce_trader.v_recent_broker_orders AS
SELECT
  id,
  idempotency_key,
  broker,
  ticker,
  side,
  order_type,
  quantity,
  limit_price,
  stop_price,
  target_price,
  status,
  broker_order_id,
  filled_quantity,
  avg_fill_price,
  reconciliation_status,
  reconciled_at,
  submitted_at,
  filled_at,
  canceled_at,
  paper_trade_id,
  intraday_trade_id,
  last_error,
  created_at
FROM bounce_trader.broker_orders
ORDER BY created_at DESC
LIMIT 100;

CREATE OR REPLACE VIEW bounce_trader.v_broker_recon_status AS
SELECT
  reconciliation_status AS group_key,
  COUNT(*)::INT AS orders,
  MAX(reconciled_at) AS most_recent_recon
FROM bounce_trader.broker_orders
GROUP BY reconciliation_status;

CREATE OR REPLACE VIEW bounce_trader.v_recent_run_logs AS
SELECT id, run_date, job_name, status, details, duration_ms, ran_at
FROM bounce_trader.run_logs
ORDER BY ran_at DESC
LIMIT 50;

CREATE OR REPLACE VIEW bounce_trader.v_recent_daily_summaries AS
SELECT id, run_date, markdown, emailed, email_reason, generated_at
FROM bounce_trader.daily_summaries
ORDER BY run_date DESC, generated_at DESC
LIMIT 30;

-- Dashboard reads: anon and authenticated may select from views only.
GRANT SELECT ON bounce_trader.v_dashboard_today_candidates TO anon, authenticated;
GRANT SELECT ON bounce_trader.v_dashboard_open_trades TO anon, authenticated;
GRANT SELECT ON bounce_trader.v_dashboard_recent_closed_trades TO anon, authenticated;
GRANT SELECT ON bounce_trader.v_basic_stats_by_tier TO anon, authenticated;
GRANT SELECT ON bounce_trader.v_basic_stats_by_screen TO anon, authenticated;
GRANT SELECT ON bounce_trader.v_recent_run_logs TO anon, authenticated;
GRANT SELECT ON bounce_trader.v_recent_daily_summaries TO authenticated;
GRANT SELECT ON bounce_trader.v_ai_cost_daily TO anon, authenticated;
GRANT SELECT ON bounce_trader.v_basic_stats_by_prompt TO anon, authenticated;
GRANT SELECT ON bounce_trader.v_basic_stats_by_selloff TO anon, authenticated;
GRANT SELECT ON bounce_trader.v_basic_stats_by_sector TO anon, authenticated;
GRANT SELECT ON bounce_trader.v_basic_stats_by_disposition TO anon, authenticated;
GRANT SELECT ON bounce_trader.v_candidates_per_day TO anon, authenticated;
GRANT SELECT ON bounce_trader.v_pnl_per_day TO anon, authenticated;
GRANT SELECT ON bounce_trader.v_baseline_stats TO anon, authenticated;
GRANT SELECT ON bounce_trader.baseline_trades TO anon, authenticated;
GRANT SELECT ON bounce_trader.baseline_progression TO anon, authenticated;
GRANT SELECT ON bounce_trader.intraday_signals TO anon, authenticated;
GRANT SELECT ON bounce_trader.intraday_paper_trades TO anon, authenticated;
GRANT SELECT ON bounce_trader.intraday_progression TO anon, authenticated;
GRANT SELECT ON bounce_trader.v_recent_intraday_trades TO anon, authenticated;
GRANT SELECT ON bounce_trader.v_recent_broker_orders TO authenticated;
GRANT SELECT ON bounce_trader.v_broker_recon_status TO authenticated;

-- Views inherit security from their underlying tables. Mark them
-- security_invoker so that PostgREST evaluates RLS using the caller's role
-- (anon) instead of the view owner's role. Combined with no anon-grant on the
-- base tables, this makes the views the only anon-readable surface.
ALTER VIEW bounce_trader.v_dashboard_today_candidates SET (security_invoker = on);
ALTER VIEW bounce_trader.v_dashboard_open_trades SET (security_invoker = on);
ALTER VIEW bounce_trader.v_dashboard_recent_closed_trades SET (security_invoker = on);
ALTER VIEW bounce_trader.v_basic_stats_by_tier SET (security_invoker = on);
ALTER VIEW bounce_trader.v_basic_stats_by_screen SET (security_invoker = on);
ALTER VIEW bounce_trader.v_recent_run_logs SET (security_invoker = on);
ALTER VIEW bounce_trader.v_recent_daily_summaries SET (security_invoker = on);
ALTER VIEW bounce_trader.v_ai_cost_daily SET (security_invoker = on);
ALTER VIEW bounce_trader.v_basic_stats_by_prompt SET (security_invoker = on);
ALTER VIEW bounce_trader.v_basic_stats_by_selloff SET (security_invoker = on);
ALTER VIEW bounce_trader.v_basic_stats_by_sector SET (security_invoker = on);
ALTER VIEW bounce_trader.v_basic_stats_by_disposition SET (security_invoker = on);
ALTER VIEW bounce_trader.v_candidates_per_day SET (security_invoker = on);
ALTER VIEW bounce_trader.v_pnl_per_day SET (security_invoker = on);
ALTER VIEW bounce_trader.v_baseline_stats SET (security_invoker = on);
ALTER VIEW bounce_trader.v_recent_intraday_trades SET (security_invoker = on);
ALTER VIEW bounce_trader.v_recent_broker_orders SET (security_invoker = on);
ALTER VIEW bounce_trader.v_broker_recon_status SET (security_invoker = on);

-- security_invoker views require BOTH a permissive RLS policy AND a
-- table-level GRANT on the underlying tables. Without the GRANT, anon hits
-- 42501 / "permission denied for table candidates" even when the policy
-- evaluates to true. Service role bypasses RLS and grants by default.
GRANT SELECT ON bounce_trader.candidates TO anon, authenticated;
GRANT SELECT ON bounce_trader.pre_flags TO anon, authenticated;
GRANT SELECT ON bounce_trader.analyses TO anon, authenticated;
GRANT SELECT ON bounce_trader.paper_trades TO anon, authenticated;
GRANT SELECT ON bounce_trader.trade_progression TO anon, authenticated;
GRANT SELECT ON bounce_trader.run_logs TO anon, authenticated;

-- Authenticated-only tables backing security_invoker views. Without these
-- direct GRANTs, the v_recent_daily_summaries / v_recent_broker_orders /
-- v_broker_recon_status views return 42501 "permission denied for table"
-- under the authenticated role even though the view itself is granted to
-- authenticated. The dashboard previously hid the failure inside try/catch
-- and looked empty for the operator; this GRANT makes those panels populate.
GRANT SELECT ON bounce_trader.daily_summaries TO authenticated;
GRANT SELECT ON bounce_trader.broker_orders TO authenticated;
GRANT SELECT ON bounce_trader.broker_positions TO authenticated;

-- Anon-readable RLS policies on the underlying tables for the columns/rows
-- the views surface. We allow read-only access to the rows needed by the
-- dashboard. catalysts and wash_sale_lockout are intentionally NOT granted
-- to anon and have no policy, so they remain admin-only.
DROP POLICY IF EXISTS anon_read_candidates ON bounce_trader.candidates;
CREATE POLICY anon_read_candidates ON bounce_trader.candidates
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS anon_read_pre_flags ON bounce_trader.pre_flags;
CREATE POLICY anon_read_pre_flags ON bounce_trader.pre_flags
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS anon_read_analyses ON bounce_trader.analyses;
CREATE POLICY anon_read_analyses ON bounce_trader.analyses
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS anon_read_paper_trades ON bounce_trader.paper_trades;
CREATE POLICY anon_read_paper_trades ON bounce_trader.paper_trades
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS anon_read_trade_progression ON bounce_trader.trade_progression;
CREATE POLICY anon_read_trade_progression ON bounce_trader.trade_progression
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS anon_read_run_logs ON bounce_trader.run_logs;
CREATE POLICY anon_read_run_logs ON bounce_trader.run_logs
  FOR SELECT TO anon, authenticated USING (true);

-- daily_summaries are intentionally authenticated-only: anon dashboard view
-- never sees the body of historical reports.
DROP POLICY IF EXISTS auth_read_daily_summaries ON bounce_trader.daily_summaries;
CREATE POLICY auth_read_daily_summaries ON bounce_trader.daily_summaries
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS anon_read_baseline_trades ON bounce_trader.baseline_trades;
CREATE POLICY anon_read_baseline_trades ON bounce_trader.baseline_trades
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS anon_read_baseline_progression ON bounce_trader.baseline_progression;
CREATE POLICY anon_read_baseline_progression ON bounce_trader.baseline_progression
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS anon_read_intraday_signals ON bounce_trader.intraday_signals;
CREATE POLICY anon_read_intraday_signals ON bounce_trader.intraday_signals
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS anon_read_intraday_paper_trades ON bounce_trader.intraday_paper_trades;
CREATE POLICY anon_read_intraday_paper_trades ON bounce_trader.intraday_paper_trades
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS anon_read_intraday_progression ON bounce_trader.intraday_progression;
CREATE POLICY anon_read_intraday_progression ON bounce_trader.intraday_progression
  FOR SELECT TO anon, authenticated USING (true);

-- broker_orders and broker_positions are authenticated-only. The dashboard
-- shows broker reconciliation state to the operator but never to anon users
-- (and there is no public broker mode anyway).
DROP POLICY IF EXISTS auth_read_broker_orders ON bounce_trader.broker_orders;
CREATE POLICY auth_read_broker_orders ON bounce_trader.broker_orders
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS auth_read_broker_positions ON bounce_trader.broker_positions;
CREATE POLICY auth_read_broker_positions ON bounce_trader.broker_positions
  FOR SELECT TO authenticated USING (true);

-- catalysts and wash_sale_lockout are not exposed to the dashboard. No anon
-- policy means anon SELECTs return zero rows even though RLS is enabled.
