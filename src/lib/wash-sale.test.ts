import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface UpsertCall {
  table: string;
  payload: { ticker: string; lockout_until: string; reason: string };
  onConflict: string | undefined;
}

const calls: UpsertCall[] = [];
let nextError: { message: string } | null = null;

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from(table: string) {
      return {
        upsert(payload: UpsertCall['payload'], opts?: { onConflict?: string }) {
          calls.push({ table, payload, onConflict: opts?.onConflict });
          return Promise.resolve({ error: nextError });
        }
      };
    }
  })
}));

const { recordWashSaleLockoutIfLoss, WASH_SALE_LOCKOUT_DAYS } = await import('./wash-sale');

describe('recordWashSaleLockoutIfLoss', () => {
  beforeEach(() => {
    calls.length = 0;
    nextError = null;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('writes a 30-day lockout when pnlPctNet is negative', async () => {
    const out = await recordWashSaleLockoutIfLoss('AAPL', '2026-05-11', -0.03);
    expect(out).toEqual({ wrote: true, reason: 'wrote' });
    expect(calls.length).toBe(1);
    expect(calls[0].table).toBe('wash_sale_lockout');
    expect(calls[0].payload).toEqual({
      ticker: 'AAPL',
      lockout_until: '2026-06-10',
      reason: 'closed_at_loss'
    });
    expect(calls[0].onConflict).toBe('ticker,lockout_until');
    expect(WASH_SALE_LOCKOUT_DAYS).toBe(30);
  });

  it('does nothing when pnlPctNet is positive', async () => {
    const out = await recordWashSaleLockoutIfLoss('NVDA', '2026-05-11', 0.05);
    expect(out).toEqual({ wrote: false, reason: 'profit' });
    expect(calls.length).toBe(0);
  });

  it('does nothing when pnlPctNet is exactly zero (break-even)', async () => {
    const out = await recordWashSaleLockoutIfLoss('GOOG', '2026-05-11', 0);
    expect(out).toEqual({ wrote: false, reason: 'profit' });
    expect(calls.length).toBe(0);
  });

  it('does nothing when pnlPctNet is null', async () => {
    const out = await recordWashSaleLockoutIfLoss('META', '2026-05-11', null);
    expect(out).toEqual({ wrote: false, reason: 'no_pnl' });
    expect(calls.length).toBe(0);
  });

  it('does not throw when the upsert errors; returns reason=error', async () => {
    nextError = { message: 'permission denied' };
    const out = await recordWashSaleLockoutIfLoss('TSLA', '2026-05-11', -0.08);
    expect(out).toEqual({ wrote: false, reason: 'error' });
    expect(calls.length).toBe(1);
  });
});
