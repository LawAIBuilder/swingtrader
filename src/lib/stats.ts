import { getSupabaseAdmin } from '@/lib/supabase/admin';

export interface BasicStatsRow {
  group_key: string;
  closed_trades: number;
  win_rate: number | null;
  avg_pnl_net: number | null;
  avg_pnl_gross: number | null;
  ambiguous_rate: number | null;
}

export async function getStatsByTier(): Promise<BasicStatsRow[]> {
  const { data, error } = await getSupabaseAdmin().from('v_basic_stats_by_tier').select('*').order('group_key');
  if (error) throw error;
  return (data ?? []) as unknown as BasicStatsRow[];
}

export async function getStatsByScreen(): Promise<BasicStatsRow[]> {
  const { data, error } = await getSupabaseAdmin().from('v_basic_stats_by_screen').select('*').order('group_key');
  if (error) throw error;
  return (data ?? []) as unknown as BasicStatsRow[];
}
