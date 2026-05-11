# Cursor Instructions

## Non-negotiable constraints

1. Keep this repo paper-only.
2. Do not add Alpaca live order placement yet.
3. Do not add a brokerage account transfer flow.
4. Do not remove the Phase 1B baseline gate from the roadmap.
5. Do not let AI set stops, targets, or position sizing. Code owns risk.

## First Cursor pass

Run:

```bash
npm install
npm run typecheck
npm test
```

Fix any package-version or TypeScript issues caused by newer libraries.

Then run mock mode:

```bash
cp .env.example .env
# fill Supabase vars
# set MOCK_MARKET_DATA=true and USE_MOCK_AI=true
npm run jobs:screener
npm run jobs:outcomes
npm run jobs:summary
npm run dev
```

Verify the dashboard shows rows.

## Real API pass

1. Set `POLYGON_API_KEY`.
2. Keep `USE_MOCK_AI=true` first.
3. Run `npm run smoke:historical`.
4. Confirm the screener returns 5-20 sensible candidates per active market day.
5. Set `ANTHROPIC_API_KEY` and `USE_MOCK_AI=false`.
6. Run one real screener job and inspect `analyses.raw_response`.

## Files to inspect first

- `supabase/schema.sql`
- `src/jobs/screener.ts`
- `src/lib/screener/run.ts`
- `src/lib/preflags.ts`
- `src/lib/ai/analyzer.ts`
- `src/jobs/outcomes.ts`
- `src/lib/simulator.ts`
- `src/app/page.tsx`

## Known gaps by design

- Earnings blackout is keyword-based in MVP.
- EDGAR parser is not implemented.
- Intraday OHLC ambiguity lookup is not implemented.
- Phase 1B baselines are not implemented.
- Auth is not implemented.
- No live execution.

## Preferred fixes

- Prefer small, typed functions over large rewrites.
- Add tests before changing simulator or risk logic.
- Keep env knobs in `.env.example` when adding new behavior.
- Keep Supabase schema migration-compatible.
