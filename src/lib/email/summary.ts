import { getStatsByScreen, getStatsByTier } from '@/lib/stats';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { pct, pctAlready } from '@/lib/utils/numbers';

export async function renderDailySummary(runDate: string): Promise<string> {
  const supabase = getSupabaseAdmin();
  const [{ data: candidates }, { data: openTrades }, { data: closedTrades }, tierStats, screenStats] = await Promise.all([
    supabase.from('candidates').select('*').eq('screen_date', runDate).order('ticker'),
    supabase.from('paper_trades').select('*').eq('status', 'open').order('entry_date'),
    supabase.from('paper_trades').select('*').eq('exit_date', runDate).order('ticker'),
    getStatsByTier(),
    getStatsByScreen()
  ]);

  const lines: string[] = [];
  lines.push(`# Bounce Trader Daily Summary - ${runDate}`);
  lines.push('');
  lines.push('## Today candidates');
  if (!candidates || candidates.length === 0) lines.push('No candidates found.');
  else {
    for (const c of candidates as any[]) {
      lines.push(`- ${c.ticker} (${c.screen_source}): ${pctAlready(c.pct_change)}, rel vol ${Number(c.rel_volume ?? 0).toFixed(2)}x, sector ${c.sector ?? '-'}`);
    }
  }

  lines.push('');
  lines.push('## Open paper trades');
  if (!openTrades || openTrades.length === 0) lines.push('No open paper trades.');
  else {
    for (const t of openTrades as any[]) {
      lines.push(`- ${t.ticker} ${t.effective_tier}: entry ${t.entry_price}, stop ${t.stop_price}, target ${t.target_price}`);
    }
  }

  lines.push('');
  lines.push('## Closed today');
  if (!closedTrades || closedTrades.length === 0) lines.push('No trades closed today.');
  else {
    for (const t of closedTrades as any[]) {
      lines.push(`- ${t.ticker} ${t.effective_tier}: ${t.exit_reason}, net ${pct(t.pnl_pct_net)}`);
    }
  }

  lines.push('');
  lines.push('## Stats by tier');
  for (const s of tierStats) {
    lines.push(`- ${s.group_key}: ${s.closed_trades} closed, win ${pct(s.win_rate)}, avg net ${pct(s.avg_pnl_net)}, ambiguous ${pct(s.ambiguous_rate)}`);
  }

  lines.push('');
  lines.push('## Stats by screen');
  for (const s of screenStats) {
    lines.push(`- ${s.group_key}: ${s.closed_trades} closed, win ${pct(s.win_rate)}, avg net ${pct(s.avg_pnl_net)}, ambiguous ${pct(s.ambiguous_rate)}`);
  }

  return lines.join('\n');
}
