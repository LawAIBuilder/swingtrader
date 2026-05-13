import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/run-log', () => ({
  withRunLog: async <T,>(_jobName: string, _opts: unknown, fn: () => Promise<T>): Promise<T> => fn(),
  JobLockedError: class JobLockedError extends Error {
    readonly name = 'JobLockedError';
  }
}));

interface FakeRow {
  table: string;
  status?: string;
  ran_at?: string;
  observed_at?: string;
}

let storage: FakeRow[] = [];
// Tests can flip this to simulate "table doesn't exist on this deploy".
let intradayMissing = false;

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from(table: string) {
      const filters: Array<(r: FakeRow) => boolean> = [(r) => r.table === table];
      const builder = {
        select(_cols: string, opts?: { count?: 'exact'; head?: boolean }) {
          // Return a chainable that ALWAYS resolves to a count when count='exact'.
          const chain: {
            eq: (col: string, val: unknown) => typeof chain;
            lt: (col: string, val: unknown) => typeof chain;
            then: (resolve: (v: unknown) => unknown) => unknown;
          } = {
            eq(col: string, val: unknown) {
              filters.push((r) => (r as unknown as Record<string, unknown>)[col] === val);
              return chain;
            },
            lt(col: string, val: unknown) {
              filters.push((r) => (r as unknown as Record<string, unknown>)[col] != null && ((r as unknown as Record<string, string>)[col] as string) < (val as string));
              return chain;
            },
            then(resolve: (v: unknown) => unknown) {
              if (intradayMissing && table === 'intraday_progression') {
                return resolve({ count: null, error: { message: 'relation "intraday_progression" does not exist' } });
              }
              const matches = storage.filter((r) => filters.every((f) => f(r)));
              if (opts?.count === 'exact') {
                return resolve({ count: matches.length, error: null });
              }
              return resolve({ data: matches, error: null });
            }
          };
          return chain;
        },
        delete() {
          const delFilters: Array<(r: FakeRow) => boolean> = [(r) => r.table === table];
          const chain: {
            eq: (col: string, val: unknown) => typeof chain;
            lt: (col: string, val: unknown) => typeof chain;
            then: (resolve: (v: unknown) => unknown) => unknown;
          } = {
            eq(col: string, val: unknown) {
              delFilters.push((r) => (r as unknown as Record<string, unknown>)[col] === val);
              return chain;
            },
            lt(col: string, val: unknown) {
              delFilters.push((r) => ((r as unknown as Record<string, string>)[col] as string) < (val as string));
              return chain;
            },
            then(resolve: (v: unknown) => unknown) {
              if (intradayMissing && table === 'intraday_progression') {
                return resolve({ data: null, error: { message: 'relation "intraday_progression" does not exist' } });
              }
              storage = storage.filter((r) => !delFilters.every((f) => f(r)));
              return resolve({ data: null, error: null });
            }
          };
          return chain;
        }
      };
      return builder;
    }
  })
}));

const { runRetentionJob, DEFAULT_RETENTION } = await import('./retention');

describe('runRetentionJob', () => {
  beforeEach(() => {
    storage = [];
    intradayMissing = false;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('deletes old run_logs (general window) and old skipped run_logs separately', async () => {
    storage.push(
      { table: 'run_logs', status: 'success', ran_at: '2025-12-01T00:00:00Z' }, // older than 90d
      { table: 'run_logs', status: 'skipped', ran_at: '2026-04-01T00:00:00Z' }, // older than 30d skipped
      { table: 'run_logs', status: 'success', ran_at: '2026-05-01T00:00:00Z' } // recent, keep
    );
    const r = await runRetentionJob({ runDate: '2026-05-11' });
    expect(r.errors).toEqual([]);
    expect(r.totalDeleted).toBe(2);
    expect(storage.find((s) => s.ran_at === '2026-05-01T00:00:00Z')).toBeDefined();
    expect(storage.find((s) => s.ran_at === '2025-12-01T00:00:00Z')).toBeUndefined();
    expect(storage.find((s) => s.status === 'skipped')).toBeUndefined();
  });

  it('deletes old intraday_progression rows', async () => {
    storage.push(
      { table: 'intraday_progression', observed_at: '2026-01-01T00:00:00Z' }, // > 60d ago
      { table: 'intraday_progression', observed_at: '2026-05-01T00:00:00Z' } // recent
    );
    const r = await runRetentionJob({ runDate: '2026-05-11' });
    expect(r.errors).toEqual([]);
    expect(r.totalDeleted).toBe(1);
  });

  it('treats missing intraday_progression table as zero rows, not an error', async () => {
    intradayMissing = true;
    storage.push({ table: 'run_logs', status: 'success', ran_at: '2025-12-01T00:00:00Z' });
    const r = await runRetentionJob({ runDate: '2026-05-11' });
    expect(r.errors).toEqual([]);
    expect(r.totalDeleted).toBe(1);
  });

  it('exposes default retention thresholds', () => {
    expect(DEFAULT_RETENTION).toEqual({
      runLogsKeepDays: 90,
      intradayProgressionKeepDays: 60,
      skippedRunLogsKeepDays: 30
    });
  });
});
