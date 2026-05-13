import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/run-log', () => ({
  withRunLog: async <T,>(_jobName: string, _opts: unknown, fn: () => Promise<T>): Promise<T> => fn()
}));

vi.mock('@/lib/email/summary', () => ({
  renderDailySummary: vi.fn(async (date: string) => `# Bounce Trader Daily Summary - ${date}\n\nrendered`)
}));

const sendMock = vi.fn();
vi.mock('@/lib/email/send', () => ({
  sendEmail: (...args: unknown[]) => sendMock(...args)
}));

const upsertMock = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: () => ({
      upsert: (...args: unknown[]) => {
        upsertMock(...args);
        return Promise.resolve({ data: null, error: null });
      }
    })
  })
}));

vi.mock('@/lib/env', () => ({
  hasSupabaseConfig: () => true,
  env: { supabaseUrl: 'https://stub', supabaseServiceRoleKey: 'stub' }
}));

const { runDailySummaryJob } = await import('./summary');

beforeEach(() => {
  sendMock.mockReset();
  upsertMock.mockReset();
  sendMock.mockResolvedValue({ sent: true, reason: undefined });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('runDailySummaryJob dryRun', () => {
  it('returns markdown without sending email or upserting when dryRun=true', async () => {
    const result = await runDailySummaryJob({ runDate: '2026-05-11', dryRun: true });
    expect(sendMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.emailed).toBe(false);
    expect(result.persisted).toBe(false);
    expect(result.markdownPreview).toContain('# Bounce Trader Daily Summary - 2026-05-11');
    expect(result.reason).toBe('dry_run');
    expect(result.errors).toEqual([]);
  });

  it('emails and persists on the normal path when dryRun is omitted', async () => {
    const result = await runDailySummaryJob({ runDate: '2026-05-11' });
    expect(sendMock).toHaveBeenCalledOnce();
    expect(upsertMock).toHaveBeenCalledOnce();
    expect(result.dryRun).toBeUndefined();
    expect(result.emailed).toBe(true);
    expect(result.persisted).toBe(true);
  });

  it('records an email error in result.errors but does not throw on the normal path', async () => {
    sendMock.mockResolvedValueOnce({ sent: false, reason: 'resend_503' });
    const result = await runDailySummaryJob({ runDate: '2026-05-11' });
    expect(result.emailed).toBe(false);
    expect(result.errors.some((e) => e.stage === 'email' && e.message === 'resend_503')).toBe(true);
  });
});
