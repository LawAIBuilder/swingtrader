import { logError } from '@/lib/log';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { addDays } from '@/lib/utils/dates';

// Wash-sale lockout window. The IRS rule is 30 calendar days after a realized
// loss; for paper-research integrity we use the same window so the screener
// won't repeatedly re-flag the same losing setup. preflags reads
// wash_sale_lockout where lockout_until >= signal_date and marks the
// candidate SKIP. Without this writer the table only gets manual seed rows.
//
// Composite primary key on (ticker, lockout_until) means we can layer
// multiple lockouts for the same ticker (e.g. several losses in a row each
// extend the window because the latest row's lockout_until is the largest).
// `onConflict: 'ticker,lockout_until'` makes the upsert idempotent if the
// outcome tracker reruns over the same exit_date.
export const WASH_SALE_LOCKOUT_DAYS = 30;

export async function recordWashSaleLockoutIfLoss(
  ticker: string,
  exitDate: string,
  pnlPctNet: number | null
): Promise<{ wrote: boolean; reason: 'no_pnl' | 'profit' | 'wrote' | 'error' }> {
  if (pnlPctNet == null) return { wrote: false, reason: 'no_pnl' };
  if (pnlPctNet >= 0) return { wrote: false, reason: 'profit' };
  const supabase = getSupabaseAdmin();
  const lockoutUntil = addDays(exitDate, WASH_SALE_LOCKOUT_DAYS);
  const { error } = await supabase
    .from('wash_sale_lockout')
    .upsert(
      { ticker, lockout_until: lockoutUntil, reason: 'closed_at_loss' },
      { onConflict: 'ticker,lockout_until' }
    );
  if (error) {
    // Don't fail the outcome tracker on a wash-sale write error: the lockout
    // is preventative, not corrective. Surface it for visibility but keep
    // closing the trade.
    logError('wash_sale_lockout_write_failed', {
      ticker,
      exitDate,
      pnlPctNet,
      supabaseError: error.message
    });
    return { wrote: false, reason: 'error' };
  }
  return { wrote: true, reason: 'wrote' };
}
