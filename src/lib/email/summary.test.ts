import { describe, expect, it, vi } from 'vitest';

interface FakeFromCall {
  table: string;
  eq?: { col: string; val: unknown };
}

const calls: FakeFromCall[] = [];

// Per-table fixed-response fake. Each describes: select -> eq -> order? -> resolve(data).
const tableData: Record<string, unknown[]> = {
  candidates: [
    { ticker: 'AAPL', screen_source: 'screen_a', pct_change: -0.075, rel_volume: 1.8, sector: 'Technology' },
    { ticker: 'NVDA', screen_source: 'screen_b', pct_change: -0.12, rel_volume: 2.1, sector: 'Technology' }
  ],
  paper_trades_open: [
    { ticker: 'NVDA', effective_tier: 'BUY', entry_price: 800, stop_price: 760, target_price: 880 }
  ],
  paper_trades_closed: [
    { ticker: 'AMD', effective_tier: 'BUY', exit_reason: 'target', pnl_pct_net: 0.04 },
    { ticker: 'TSLA', effective_tier: 'PASS', exit_reason: 'stop', pnl_pct_net: -0.025 }
  ],
  v_ai_cost_daily: [{ total_cost_usd: 0.0142, total_calls: 3 }],
  v_basic_stats_by_tier: [
    { group_key: 'BUY', closed_trades: 12, win_rate: 0.58, avg_pnl_net: 0.012, ambiguous_rate: 0.08 },
    { group_key: 'PASS', closed_trades: 5, win_rate: 0.4, avg_pnl_net: -0.005, ambiguous_rate: 0.0 }
  ],
  v_basic_stats_by_screen: [
    { group_key: 'screen_a', closed_trades: 9, win_rate: 0.55, avg_pnl_net: 0.011, ambiguous_rate: 0.05 }
  ]
};

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from(table: string) {
      const ctx: { table: string; status?: string; eqArgs: Array<{ col: string; val: unknown }> } = {
        table,
        eqArgs: []
      };
      const builder = {
        select() {
          return builder;
        },
        eq(col: string, val: unknown) {
          ctx.eqArgs.push({ col, val });
          return builder;
        },
        order() {
          return resolveSelect();
        },
        // For v_ai_cost_daily we don't .order() so the chain ends at .eq(...).
        // The fake resolves on .then() to support that case.
        then(resolve: (v: unknown) => unknown) {
          return resolveSelect().then(resolve);
        }
      };
      function resolveSelect() {
        const isOpenTrades = ctx.table === 'paper_trades' && ctx.eqArgs.some((e) => e.col === 'status' && e.val === 'open');
        const isClosedToday = ctx.table === 'paper_trades' && ctx.eqArgs.some((e) => e.col === 'exit_date');
        let key = ctx.table;
        if (isOpenTrades) key = 'paper_trades_open';
        else if (isClosedToday) key = 'paper_trades_closed';
        const data = tableData[key] ?? [];
        calls.push({ table: ctx.table });
        return Promise.resolve({ data, error: null });
      }
      return builder;
    }
  })
}));

const { renderDailySummary } = await import('./summary');

describe('renderDailySummary', () => {
  it('renders a complete markdown summary including counts, trades, and AI cost', async () => {
    const md = await renderDailySummary('2026-05-11');
    expect(md).toContain('# Bounce Trader Daily Summary - 2026-05-11');
    expect(md).toContain('## Today summary');
    expect(md).toContain('Candidates: 2');
    expect(md).toContain('Open paper trades: 1');
    expect(md).toContain('Closed today: 2');
    expect(md).toContain('AI calls: 3');
    expect(md).toContain('AI cost: $0.0142');

    expect(md).toContain('## Today candidates');
    expect(md).toContain('AAPL (screen_a)');
    expect(md).toContain('NVDA (screen_b)');

    expect(md).toContain('## Open paper trades');
    expect(md).toContain('NVDA BUY: entry 800');

    expect(md).toContain('## Closed today');
    expect(md).toContain('AMD BUY: target');
    expect(md).toContain('TSLA PASS: stop');

    expect(md).toContain('## Stats by tier (rolling)');
    expect(md).toContain('BUY: 12 closed');
    expect(md).toContain('## Stats by screen (rolling)');
    expect(md).toContain('screen_a: 9 closed');
  });
});
