# Architecture

## Phase 1A flow

```text
4:15 PM ET cron (post-close)
  -> runScreenerJob
  -> fetch grouped daily market bars
  -> assert dataDate === runDate (else MarketDataNotSettledError -> skipped run)
  -> compute Screen A and Screen B metrics
  -> fetch ticker details for rough candidates
  -> apply universe filter
  -> insert candidates
  -> fetch news catalyst evidence
  -> apply pre-flags
  -> call Claude for OK_FOR_AI candidates
  -> create paper_trade row:
       entry_mode='next_day_open' (default): status='pending_entry',
         entry_price/stop/target left NULL, entry_date set to next business day.
       entry_mode='signal_close' (diagnostic): status='open' immediately at
         signal-day close. Not executable in practice.

5:00 PM ET cron
  -> runOutcomeTrackerJob
  -> for each pending_entry trade whose entry_date <= runDate:
       fetch daily bars from entry_date through runDate, take the first available
       bar, set entry_price = bar.open, compute stop/target, status='open',
       then evaluate that same bar as day 1.
  -> for each already-open trade:
       fetch daily OHLC, detect stop/target/time stop, conservative stop-first
       rule on ambiguous bars, write trade_progression, close paper_trade if hit.

5:30 PM ET cron
  -> render summary
  -> email via Resend or write reports/*.md fallback
```

## Clock and entry semantics (PR 1)

The cron schedule is post-close because Polygon's grouped daily aggregate is not
settled at 3:30 PM ET. Running before settlement would silently use the prior
business day's bars. To make stale-data runs impossible rather than merely
unlikely, `runScreener` asserts `dataDate === runDate` and raises
`MarketDataNotSettledError` otherwise. The job logs a skipped run and waits for
the next scheduled execution.

`entry_mode` controls how `paper_trade.entry_price` is determined.

- `next_day_open` (default, primary series): screening happens after close on
  `signal_date`, so the trade cannot enter on that bar without look-ahead. The
  paper trade is inserted as `pending_entry` with `entry_date` set to the next
  business day. The outcome tracker promotes it the first time a bar at or after
  `entry_date` is available, taking the open of that bar as `entry_price` and
  using the deterministic stop/target formulas. The same bar is then evaluated
  as day 1 of the trade.
- `signal_close` (diagnostic only): preserves the original behavior where
  `entry_price` equals `signal_date` close. Useful as a comparison series so we
  can quantify how much P&L came from the artificial close-entry rather than the
  realistic next-day open. Not a baseline.

## App/server strategy

`src/server.ts` runs Express, Next, HTTP job endpoints, and cron schedules in one process. This matches the v0.4 goal of a single Railway-hosted TypeScript service.

For development, `npm run dev:web` can run dashboard only, and `npm run dev:worker` can run job endpoints only.

## Data-source strategy

The code uses a `MarketDataClient` interface. The default implementation is Polygon/Massive because grouped daily bars are convenient for broad-universe screening. Mock mode implements the same interface for local development.

`src/lib/market/alpaca.ts` is intentionally per-ticker only. Broad-universe Alpaca screening should be added only if you decide the free Alpaca feed is worth the extra implementation complexity.

## Risk strategy

The AI never controls risk numbers.

Stop and target:

```text
stop_distance = max(1.5 * ATR14, entry - signal_day_low + 0.10)
stop_price = entry - stop_distance
target_price = entry + 2 * stop_distance
```

Slippage is modeled by liquidity bucket and applied round-trip.

## Phase 1B extensions

Add these after Phase 1A is collecting data:

1. Baseline trades: buy_all, rules_only, random_tier, SPY, sector.
2. Bootstrap confidence intervals with repeat-ticker cluster correction.
3. SEC EDGAR parser for offerings and dilution.
4. Intraday lookup for ambiguous daily bars.
5. Corporate action price adjustment.
6. Data provenance and prompt hashing.
7. Auth and stronger observability.
