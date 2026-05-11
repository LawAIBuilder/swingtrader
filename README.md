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
  -H "x-cron-secret: $CRON_SECRET" \
  -d '{"runDate":"2026-05-11"}'
```

Available endpoints:

- `POST /jobs/screener`
- `POST /jobs/outcomes`
- `POST /jobs/summary`
- `GET /health`

If `CRON_SECRET` is blank, endpoints are unprotected. Use a secret before deploying.

## Railway deployment

One-service deployment:

- Build command: `npm run build`
- Start command: `npm run start:railway`
- Set `ENABLE_CRON=true`
- Set `ENABLE_WEB=true`
- Set all env vars from `.env.example`

Cron schedule in `src/server.ts`:

- Screener: 4:15 PM ET, weekdays (post-close; required for settled daily bars)
- Outcome tracker: 5:00 PM ET, weekdays
- Daily summary: 5:30 PM ET, weekdays

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
skipped run rather than silently use stale data.

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
