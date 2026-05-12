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

const { fetchDashboardData } = await import('./data');

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
