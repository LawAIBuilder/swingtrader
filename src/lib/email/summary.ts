import { getStatsByScreen, getStatsByTier } from '@/lib/stats';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { pct, pctAlready } from '@/lib/utils/numbers';

interface CandidateRow {
  ticker: string;
  screen_source: string;
  pct_change: number;
  rel_volume: number | null;
  sector: string | null;
}

interface OpenTradeRow {
  ticker: string;
  effective_tier: string;
  entry_price: number;
  stop_price: number;
  target_price: number;
}

interface ClosedTradeRow {
  ticker: string;
  effective_tier: string;
  exit_reason: string | null;
  pnl_pct_net: number | null;
}

interface AiCostRow {
  total_cost_usd: number | null;
  total_calls: number | null;
}

export async function renderDailySummary(runDate: string): Promise<string> {
  const supabase = getSupabaseAdmin();
  const [
    { data: candidates },
    { data: openTrades },
    { data: closedTrades },
    { data: aiCostRows },
    tierStats,
    screenStats
  ] = await Promise.all([
    supabase.from('candidates').select('ticker,screen_source,pct_change,rel_volume,sector').eq('screen_date', runDate).order('ticker'),
    supabase.from('paper_trades').select('ticker,effective_tier,entry_price,stop_price,target_price').eq('status', 'open').order('entry_date'),
    supabase.from('paper_trades').select('ticker,effective_tier,exit_reason,pnl_pct_net').eq('exit_date', runDate).order('ticker'),
    supabase.from('v_ai_cost_daily').select('total_cost_usd,total_calls').eq('day', runDate),
    getStatsByTier(),
    getStatsByScreen()
  ]);

  const candidateRows = (candidates ?? []) as unknown as CandidateRow[];
  const openTradeRows = (openTrades ?? []) as unknown as OpenTradeRow[];
  const closedTradeRows = (closedTrades ?? []) as unknown as ClosedTradeRow[];
  const aiCost = ((aiCostRows ?? []) as unknown as AiCostRow[])[0];

  const closedTotalNet = closedTradeRows.reduce((acc, r) => acc + (r.pnl_pct_net ?? 0), 0);
  const closedAvgNet = closedTradeRows.length > 0 ? closedTotalNet / closedTradeRows.length : 0;
  const winners = closedTradeRows.filter((r) => (r.pnl_pct_net ?? 0) > 0).length;

  const lines: string[] = [];
  lines.push(`# Bounce Trader Daily Summary - ${runDate}`);
  lines.push('');

  lines.push('## Today summary');
  lines.push(`- Candidates: ${candidateRows.length}`);
  lines.push(`- Open paper trades: ${openTradeRows.length}`);
  lines.push(
    `- Closed today: ${closedTradeRows.length}` +
      (closedTradeRows.length > 0
        ? ` (${winners} winners, avg net ${pct(closedAvgNet)}, total net ${pct(closedTotalNet)})`
        : '')
  );
  if (aiCost) {
    lines.push(`- AI calls: ${aiCost.total_calls ?? 0}, AI cost: $${(aiCost.total_cost_usd ?? 0).toFixed(4)}`);
  }
  lines.push('');

  lines.push('## Today candidates');
  if (candidateRows.length === 0) {
    lines.push('No candidates found.');
  } else {
    for (const c of candidateRows) {
      const rel = Number(c.rel_volume ?? 0).toFixed(2);
      lines.push(`- ${c.ticker} (${c.screen_source}): ${pctAlready(c.pct_change)}, rel vol ${rel}x, sector ${c.sector ?? '-'}`);
    }
  }

  lines.push('');
  lines.push('## Open paper trades');
  if (openTradeRows.length === 0) {
    lines.push('No open paper trades.');
  } else {
    for (const t of openTradeRows) {
      lines.push(`- ${t.ticker} ${t.effective_tier}: entry ${t.entry_price}, stop ${t.stop_price}, target ${t.target_price}`);
    }
  }

  lines.push('');
  lines.push('## Closed today');
  if (closedTradeRows.length === 0) {
    lines.push('No trades closed today.');
  } else {
    for (const t of closedTradeRows) {
      lines.push(`- ${t.ticker} ${t.effective_tier}: ${t.exit_reason ?? 'unknown'}, net ${pct(t.pnl_pct_net ?? 0)}`);
    }
  }

  lines.push('');
  lines.push('## Stats by tier (rolling)');
  for (const s of tierStats) {
    lines.push(`- ${s.group_key}: ${s.closed_trades} closed, win ${pct(s.win_rate)}, avg net ${pct(s.avg_pnl_net)}, ambiguous ${pct(s.ambiguous_rate)}`);
  }

  lines.push('');
  lines.push('## Stats by screen (rolling)');
  for (const s of screenStats) {
    lines.push(`- ${s.group_key}: ${s.closed_trades} closed, win ${pct(s.win_rate)}, avg net ${pct(s.avg_pnl_net)}, ambiguous ${pct(s.ambiguous_rate)}`);
  }

  return lines.join('\n');
}
