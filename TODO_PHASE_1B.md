# Phase 1B TODO

- [ ] Add `baseline_trades` table.
- [ ] Create buy_all baseline from every non-SKIP candidate.
- [ ] Create rules_only baseline independent of LLM tier.
- [ ] Create SPY and sector ETF benchmark rows for each candidate window.
- [ ] Add random-tier Monte Carlo baseline.
- [ ] Add bootstrap confidence intervals.
- [ ] Cluster bootstrap by ticker to handle repeat tickers.
- [ ] Add prompt_versions with prompt text and SHA-256 hash.
- [ ] Add data provenance fields to catalysts and market bars.
- [ ] Replace news keyword offering scan with SEC EDGAR parser.
- [ ] Replace earnings keyword blackout with real earnings calendar endpoint.
- [ ] Add intraday bars lookup when daily bar touches stop and target.
- [ ] Add corporate action price adjustment.
- [ ] Add active failure alerts separate from daily summary.
- [ ] Add Supabase Auth to dashboard.
