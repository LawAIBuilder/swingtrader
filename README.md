# Bounce Trader Starter Repo

This is a Cursor-ready Phase 1A implementation of the Automated Bounce Trader v0.4 blueprint. It is a **paper-only forward data collector**: daily screener, pre-flags, Claude analysis, deterministic paper trades, conservative OHLC outcome tracking, summary email, job logs, and a read-only dashboard.

It does **not** contain live brokerage execution. Do not add live order placement until Phase 2/3 gates pass.

## What is included

- Supabase schema matching the Phase 1A data model
- TypeScript screener job with two screens
- Universe filter: main-market common stocks, market cap, price, dollar volume, country, ETF filters
- Polygon/Massive REST adapter plus mock market data mode
- Optional Alpaca per-ticker bars adapter scaffold
- News-based pre-flags for offerings, dividend suspension, earnings blackout keywords, liquidity, wash-sale lockout
- Anthropic analyzer using `claude-sonnet-4-6` by default
- Zod validation and one retry on malformed model output
- Deterministic stop/target and slippage model
- Outcome tracker with conservative stop-first ambiguity handling
- Daily summary email through Resend, with local markdown fallback
- Custom Express + Next server that can run dashboard and cron jobs in one Railway service
- Basic dashboard and Supabase views
- Unit tests for risk and simulator logic

## Current safety posture

- Paper trades only
- No brokerage order code
- No position sizing for real money
- No auto-execution
- No advice engine

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create Supabase tables

Create a Supabase project, then paste `supabase/schema.sql` into the Supabase SQL editor and run it.

Optional after schema is applied:

```bash
npm run db:types
```

That generates exact database types into `src/types/database.generated.ts` if you have the Supabase CLI configured.

### 3. Configure environment

```bash
cp .env.example .env
```

Minimum local smoke-test env:

```bash
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
MOCK_MARKET_DATA=true
USE_MOCK_AI=true
ENABLE_CRON=false
```

Production-like env also needs:

```bash
POLYGON_API_KEY=...
ANTHROPIC_API_KEY=...
RESEND_API_KEY=...
EMAIL_FROM="Bounce Trader <noreply@yourdomain.com>"
EMAIL_TO="you@example.com"
CRON_SECRET=long-random-string
```

Polygon.io rebranded to Massive.com. This repo defaults to `https://api.polygon.io` because many existing keys still work there. If your account/docs say to use Massive, set:

```bash
POLYGON_BASE_URL=https://api.massive.com
```

### 4. Run locally

Dashboard plus manual job endpoints:

```bash
npm run dev
```

Dashboard only:

```bash
npm run dev:web
```

Worker/server without dashboard:

```bash
npm run dev:worker
```

### 5. Run jobs manually

With mock data and mock AI enabled:

```bash
npm run jobs:screener
npm run jobs:outcomes
npm run jobs:summary
```

Pass a specific date if needed:

```bash
npm run jobs:screener 2026-05-11
npm run jobs:outcomes 2026-05-12
npm run jobs:summary 2026-05-12
```

Smoke-test the screener over the last 30 business days:

```bash
npm run smoke:historical
```

### 6. Trigger jobs over HTTP

When the server is running:

```bash
curl -X POST http://localhost:3000/jobs/screener \
  -H "content-type: application/json" \
  -H "authorization: Bearer $CRON_SECRET" \
  -d '{"runDate":"2026-05-11"}'
```

The legacy `x-cron-secret: $CRON_SECRET` header is also accepted.

Available endpoints:

- `POST /jobs/screener`
- `POST /jobs/outcomes`
- `POST /jobs/summary`
- `GET /health`

If `CRON_SECRET` is blank, endpoints are unprotected. Use a secret before deploying.

#### Force-rerunning a job

Each `/jobs/*` route uses a per-(date, job) run lock backed by `run_logs`. A
second invocation while a run is already in flight returns HTTP **409** and
records a `skipped` row. To override, pass `force=true`:

```bash
curl -X POST "http://localhost:3000/jobs/screener?force=1" \
  -H "authorization: Bearer $CRON_SECRET"

curl -X POST http://localhost:3000/jobs/screener \
  -H "authorization: Bearer $CRON_SECRET" \
  -H "content-type: application/json" \
  -d '{"runDate":"2026-05-11","force":true}'
```

A forced run marks the prior `running` row as `failed` with reason
`superseded_by_force`. CLIs accept `--force`:

```bash
npm run jobs:screener -- --force
npm run jobs:screener -- 2026-05-11 --force
```

## Railway deployment

One-service deployment:

- Build command: `npm run build`
- Start command: `npm run start:railway`
- Set `ENABLE_CRON=true`
- Set `ENABLE_WEB=true`
- Set all env vars from `.env.example`

Cron schedule in `src/server.ts` (DST-aware via `node-cron`'s `timezone` arg):

- Screener: 16:15 in `TZ` (default `America/New_York`), weekdays (post-close; required for settled daily bars)
- Outcome tracker: 17:00 in `TZ`, weekdays
- Daily summary: 17:30 in `TZ`, weekdays

Vercel cron schedules in `vercel.json` are fixed-UTC instead, since Vercel
Cron does not honor a TZ field. Default times are `21:15 UTC`, `22:00 UTC`,
and `22:30 UTC` weekdays — i.e. `5:15/6:00/6:30 PM EDT` during DST and
`4:15/5:00/5:30 PM EST` outside DST. Both are post-close; the EDT offset is
the asymmetric case to be aware of.

## Operational runbook (production)

These examples assume the deployed dashboard at
`https://swingtrader-two.vercel.app` and a `CRON_SECRET` set via Vercel env
vars. Replace `BASE_URL` and `CRON_SECRET` for your own deployment.

```bash
export BASE_URL=https://swingtrader-two.vercel.app
export CRON_SECRET=...   # the value set in Vercel project env vars
```

### Authenticated normal run (manual trigger)

```bash
curl -i -X POST "$BASE_URL/api/jobs/screener" \
  -H "authorization: Bearer $CRON_SECRET" \
  -H "content-type: application/json" \
  -d '{"runDate":"2026-05-11"}'
```

A successful run returns `200` and a JSON `ScreenerJobResult`. A run that
declined to enter trades (market data not yet settled) returns `200` with
`"notSettled": { "dataDate": "..." }` and is recorded in `run_logs` as
`status='partial'`. Vercel Cron uses `GET` and is otherwise identical.

### Forcing a rerun on top of a stuck or completed run

```bash
curl -i -X POST "$BASE_URL/api/jobs/screener?force=1" \
  -H "authorization: Bearer $CRON_SECRET"

curl -i -X POST "$BASE_URL/api/jobs/screener" \
  -H "authorization: Bearer $CRON_SECRET" \
  -H "content-type: application/json" \
  -d '{"runDate":"2026-05-11","force":true}'
```

`force=true` marks any prior `running` row for the same `(run_date, job_name)`
as `status='failed'` with `details.reason='superseded_by_force'`, then inserts
a new `running` row and proceeds. The original run's eventual write is a
no-op (`markRowComplete` only transitions `running → terminal`), so the
supersede marker survives.

### Expected 409 Locked response

A non-forced second run while another is in flight returns:

```http
HTTP/1.1 409 Conflict
content-type: application/json

{
  "skipped": true,
  "reason": "concurrent_run_in_progress",
  "jobName": "screener",
  "runDate": "2026-05-11"
}
```

The same condition writes a `status='skipped'` row to `run_logs` with
`details.reason='concurrent_run_in_progress'`, so the dashboard's recent-run
log shows the attempted overlap.

### Where to find boot failures in Vercel logs

`run_logs` writes require `SUPABASE_SERVICE_ROLE_KEY`. If that env var is
missing or Supabase is unreachable, the job cannot record a `failed` row. In
that case `withRunLog` emits a structured stderr line that Vercel runtime
logs capture:

```
{"event":"run_log_boot_failure","job":"screener","runDate":"2026-05-11","error":"Missing required env var: SUPABASE_SERVICE_ROLE_KEY"}
```

Equivalent for an unhandled exception that escaped the lock lifecycle:

```
{"event":"job_route_failure","job":"screener","runDate":"2026-05-11","error":"..."}
```

In the Vercel dashboard, filter runtime logs by:

- **Project**: swingtrader
- **Path** contains: `/api/jobs/`
- **Level**: `error`
- **Search**: `run_log_boot_failure` or `job_route_failure`

A 500 response with no message body in the log row means the failure happened
before this PR shipped — it predates the stderr fallback.

### Tunable timeouts and TTL

| Env var | Default | Notes |
| --- | --- | --- |
| `FETCH_TIMEOUT_MS` | 15000 | Per-request HTTP timeout for Polygon and Alpaca. |
| `ANTHROPIC_TIMEOUT_MS` | 30000 | Per-request timeout for Anthropic SDK. |
| `GROUPED_BARS_CONCURRENCY` | 4 | Parallelism for the 32-day lookback fetch. |
| `ANTHROPIC_CONCURRENCY` | 2 | Cap on in-flight `messages.create` calls. |
| `RUN_LOCK_TTL_MS` | 600000 (10 min) | Stale `running` rows older than this are reaped. |

Keep `RUN_LOCK_TTL_MS` comfortably above any function's `maxDuration`. The
screener route caps at 300s on Vercel Pro and 10s on Hobby. The outcome
tracker route caps at 300s; the summary route at 60s. The 10-min TTL leaves
ample headroom over all three on either tier.

### Staged production rollout (one env at a time)

The recommended sequence to avoid surprises when going live, given that
Vercel env-var changes require a redeploy to take effect:

1. Set only `SUPABASE_SERVICE_ROLE_KEY`, redeploy, keep `MOCK_MARKET_DATA=true`
   and `USE_MOCK_AI=true`. Manually trigger `/api/jobs/screener` and confirm a
   `run_logs` row appears via the dashboard.
2. Add `POLYGON_API_KEY`, redeploy, set `MOCK_MARKET_DATA=false`, keep
   `USE_MOCK_AI=true`. Manually trigger and confirm real candidates appear.
3. Add `ANTHROPIC_API_KEY`, redeploy, set `USE_MOCK_AI=false`. Manually
   trigger and confirm `analyses` rows are populated with real model output.
4. Optionally add `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_TO` and verify the
   summary email path on a Friday close.

## Cursor handoff prompt

Paste this into Cursor after opening the repo:

```text
You are completing a Phase 1A automated paper-trading tracker. Start by reading README.md, CURSOR_INSTRUCTIONS.md, docs/ARCHITECTURE.md, and supabase/schema.sql. Do not add live brokerage execution. First run npm install, npm run typecheck, and npm test. Fix any TypeScript/package-version issues. Then wire the real Polygon/Massive account, verify endpoints against current docs, run with MOCK_MARKET_DATA=false and USE_MOCK_AI=true, then enable Anthropic with USE_MOCK_AI=false. Keep all trading paper-only.
```

## Important implementation notes

### Entry semantics

`ENTRY_MODE` controls how paper trades enter:

- `next_day_open` (default): the screener runs after close, inserts a
  `pending_entry` paper trade, and the outcome tracker promotes it to `open`
  at the next available trading day's open. This is the executable series.
- `signal_close`: enters at signal-day close. Diagnostic only; uses the same
  bar that triggered the signal, so it is not realistic. Useful for measuring
  how much of any apparent edge depends on close-entry rather than next-open
  entry.

If the screener fires before Polygon's grouped daily bar for `runDate` has
settled, it will throw `MarketDataNotSettledError` and the job will record a
`partial` run rather than silently use stale data.

### Runtime safety (PR 2)

Every external HTTP call has an `AbortSignal`-driven per-request timeout
(`FETCH_TIMEOUT_MS`, default 15s for Polygon/Alpaca; `ANTHROPIC_TIMEOUT_MS`,
default 30s for Anthropic). The screener fans the 32-day grouped-bar lookback
across `GROUPED_BARS_CONCURRENCY` (default 4). Anthropic calls are wrapped in
a process-wide `pLimit(ANTHROPIC_CONCURRENCY)` (default 2).

Run locking lives in `run_logs` via a partial unique index on
`(run_date, job_name) WHERE status='running'`. The lifecycle is:

| Status | Meaning |
| --- | --- |
| `running` | A job is in flight for `(run_date, job_name)`. |
| `success` | Completed without errors. |
| `partial` | Completed but returned `notSettled` or non-empty `errors`. |
| `failed` | Threw, or was superseded by `force=true`, or was reaped as stale. |
| `skipped` | Refused to start because another run was in flight (no `force`). |

Crash-recovery: a `running` row older than `RUN_LOCK_TTL_MS` (default 10 min)
is reaped before lock acquisition. Boot-time failures (e.g. missing
`SUPABASE_SERVICE_ROLE_KEY` on Vercel) cannot write to `run_logs`, so they
emit a structured stderr line that Vercel runtime logs capture instead.

### Screener defaults

Screen A:

- One-day drop at or below `SCREEN_A_DROP_PCT` default -7%
- Relative volume at or above `SCREEN_A_REL_VOLUME` default 1.5x

Screen B:

- Five-day drop at or below `SCREEN_B_5D_DROP_PCT` default -12%
- Drawdown from 20-day high at or below `SCREEN_B_DRAWDOWN_20D_PCT` default -15%
- Relative volume at least 1.0x
- Current day down at least 2%

These are explicit defaults because the v0.4 blueprint references Screen A/B but does not restate their exact formulas.

### Earnings blackout

The MVP uses vendor news keyword detection for earnings blackout because the exact earnings calendar endpoint depends on your market-data subscription. Cursor should verify your vendor endpoint and replace `earningsBlackoutTerms` in `src/lib/preflags.ts` with a real earnings provider during Phase 1B.

### Market data

The broad screener defaults to Polygon/Massive grouped daily bars because it is dramatically simpler than calling per-ticker Alpaca bars for the full universe. An Alpaca per-ticker adapter is scaffolded in `src/lib/market/alpaca.ts`, but broad-universe Alpaca screening is intentionally not the default.

### Security

The dashboard uses the Supabase service role key on the server side. Do not expose this app publicly without authentication. For personal Railway/Vercel use behind a private URL, it is acceptable for Phase 1A, but add Supabase Auth before sharing.

## What Cursor should finish next

1. Run dependency install/typecheck and fix version drift.
2. Verify Polygon/Massive endpoint URLs for your paid plan.
3. Replace earnings keyword blackout with a real earnings calendar provider.
4. Add auth to the dashboard if it is exposed beyond your own private use.
5. Add Phase 1B baselines, bootstrap CI, prompt hashing, EDGAR parser, and intraday ambiguity lookup.

## Legal/trading disclaimer

This is software scaffolding for paper-trading research. It is not investment advice, tax advice, or a recommendation to trade. Live order execution is intentionally absent.
