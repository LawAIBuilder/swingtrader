import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted env: env.ts caches NEXT_PUBLIC_SUPABASE_* on first import. We must
// set them before the dashboard data module loads so hasPublicSupabaseConfig()
// returns true and fetchDashboardData actually runs the queries.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://stub.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'stub-anon';
});

interface FakeViewResult {
  data: unknown[] | null;
  error: { message: string } | null;
}

const queue: Map<string, FakeViewResult> = new Map();

function next(view: string): FakeViewResult {
  const r = queue.get(view);
  if (!r) return { data: [], error: null };
  return r;
}

class FakeBuilder {
  constructor(private view: string) {}
  select(_cols: string) {
    return this;
  }
  limit(_n: number) {
    return this;
  }
  order(_col: string, _opts?: unknown) {
    return this;
  }
  then<T>(onFulfilled?: (v: FakeViewResult) => T | PromiseLike<T>): Promise<T> {
    return Promise.resolve(next(this.view)).then(onFulfilled ?? ((v) => v as unknown as T));
  }
}

vi.mock('@/lib/supabase/public', () => ({
  getSupabasePublic: () => ({
    from: (view: string) => new FakeBuilder(view)
  })
}));

const { fetchDashboardData, deriveSystemState } = await import('./data');
type RunLogRow = Parameters<typeof deriveSystemState>[0][number];

beforeEach(() => {
  queue.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('fetchDashboardData error surfacing', () => {
  it('returns partial data with errors map when a single view fails', async () => {
    queue.set('v_dashboard_today_candidates', { data: [{ ticker: 'A' }], error: null });
    queue.set('v_dashboard_open_trades', { data: [], error: null });
    queue.set('v_dashboard_recent_closed_trades', { data: [], error: null });
    queue.set('v_basic_stats_by_tier', { data: [], error: { message: 'permission denied' } });
    queue.set('v_basic_stats_by_screen', { data: [], error: null });
    queue.set('v_recent_run_logs', { data: [], error: null });

    const data = await fetchDashboardData();
    expect(data).not.toBeNull();
    if (!data) throw new Error('unreachable');
    expect(data.todayCandidates.length).toBe(1);
    expect(data.errors['v_basic_stats_by_tier']).toContain('permission denied');
    // No other view should appear in errors.
    expect(Object.keys(data.errors).sort()).toEqual(['v_basic_stats_by_tier']);
  });

  it('returns empty errors map when every view succeeds', async () => {
    const data = await fetchDashboardData();
    expect(data).not.toBeNull();
    if (!data) throw new Error('unreachable');
    expect(data.errors).toEqual({});
  });

  it('truncates very long error messages to keep run_logs/dashboard noise bounded', async () => {
    const long = 'x'.repeat(500);
    queue.set('v_recent_run_logs', { data: [], error: { message: long } });
    const data = await fetchDashboardData();
    if (!data) throw new Error('unreachable');
    const captured = data.errors['v_recent_run_logs'];
    expect(captured).toBeDefined();
    expect(captured.length).toBeLessThanOrEqual(201 + 1); // 200 + ellipsis
    expect(captured.endsWith('…')).toBe(true);
  });
});

describe('deriveSystemState', () => {
  function row(overrides: Partial<RunLogRow>): RunLogRow {
    return {
      id: 1,
      run_date: '2026-05-11',
      job_name: 'screener',
      status: 'success',
      details: null,
      duration_ms: 100,
      ran_at: '2026-05-11T20:00:00Z',
      ...overrides
    } as RunLogRow;
  }

  it('flips aiBudgetExhaustedToday when the most recent screener run hit the cap', () => {
    const state = deriveSystemState([
      row({
        details: {
          result: {
            runDate: '2026-05-11',
            dataDate: '2026-05-11',
            aiBudgetExhausted: true,
            aiCostUsdThisRun: 1.2345,
            diagnostics: {}
          }
        }
      })
    ]);
    expect(state.aiBudgetExhaustedToday).toBeDefined();
    expect(state.aiBudgetExhaustedToday?.runDate).toBe('2026-05-11');
    expect(state.aiBudgetExhaustedToday?.spent).toBeCloseTo(1.2345);
  });

  it('leaves aiBudgetExhaustedToday undefined when the cap was not hit', () => {
    const state = deriveSystemState([
      row({
        details: {
          result: {
            runDate: '2026-05-11',
            dataDate: '2026-05-11',
            aiBudgetExhausted: false,
            aiCostUsdThisRun: 0.4,
            diagnostics: {}
          }
        }
      })
    ]);
    expect(state.aiBudgetExhaustedToday).toBeUndefined();
  });

  it('cronOpenToPublic is false in this test env (CRON_SECRET unset, ALLOW_UNAUTHENTICATED_CRON unset)', () => {
    const state = deriveSystemState([]);
    expect(state.cronOpenToPublic).toBe(false);
  });
});
