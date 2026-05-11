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
  analyzed_at TIMESTAMPTZ DEFAULT NOW()
);

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
  status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
  details JSONB,
  duration_ms INT,
  ran_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bounce_trader.wash_sale_lockout (
  ticker TEXT NOT NULL,
  lockout_until DATE NOT NULL,
  reason TEXT,
  PRIMARY KEY (ticker, lockout_until)
);

CREATE INDEX IF NOT EXISTS idx_candidates_screen_date ON bounce_trader.candidates(screen_date DESC);
CREATE INDEX IF NOT EXISTS idx_candidates_ticker_date ON bounce_trader.candidates(ticker, screen_date DESC);
CREATE INDEX IF NOT EXISTS idx_analyses_candidate_id ON bounce_trader.analyses(candidate_id);
CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON bounce_trader.paper_trades(status);
CREATE INDEX IF NOT EXISTS idx_paper_trades_ticker ON bounce_trader.paper_trades(ticker);
CREATE INDEX IF NOT EXISTS idx_paper_trades_exit_date ON bounce_trader.paper_trades(exit_date DESC);
CREATE INDEX IF NOT EXISTS idx_progression_date ON bounce_trader.trade_progression(date DESC);
CREATE INDEX IF NOT EXISTS idx_run_logs_ran_at ON bounce_trader.run_logs(ran_at DESC);

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

CREATE OR REPLACE VIEW bounce_trader.v_recent_run_logs AS
SELECT id, run_date, job_name, status, details, duration_ms, ran_at
FROM bounce_trader.run_logs
ORDER BY ran_at DESC
LIMIT 50;

-- Dashboard reads: anon and authenticated may select from views only.
GRANT SELECT ON bounce_trader.v_dashboard_today_candidates TO anon, authenticated;
GRANT SELECT ON bounce_trader.v_dashboard_open_trades TO anon, authenticated;
GRANT SELECT ON bounce_trader.v_dashboard_recent_closed_trades TO anon, authenticated;
GRANT SELECT ON bounce_trader.v_basic_stats_by_tier TO anon, authenticated;
GRANT SELECT ON bounce_trader.v_basic_stats_by_screen TO anon, authenticated;
GRANT SELECT ON bounce_trader.v_recent_run_logs TO anon, authenticated;

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

-- catalysts and wash_sale_lockout are not exposed to the dashboard. No anon
-- policy means anon SELECTs return zero rows even though RLS is enabled.
