import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory fake of the slice of supabase-js the run-log code uses. Mimics the
// partial unique index uniq_run_logs_running_per_jobdate by rejecting a second
// 'running' row for the same (run_date, job_name) with code 23505. This lets
// us exercise the lock state machine end-to-end without a real Postgres.
interface RunLogRow extends Record<string, unknown> {
  id: number;
  run_date: string;
  job_name: string;
  status: string;
  forced?: boolean;
  details?: unknown;
  duration_ms?: number | null;
  ran_at: string;
  finished_at?: string | null;
}

interface Filter {
  op: 'eq' | 'lt';
  col: string;
  val: unknown;
}

class FakeStore {
  rows: RunLogRow[] = [];
  nextId = 1;
}

class FakeBuilder {
  private filters: Filter[] = [];
  private selectCols: string | null = null;
  private isSingle = false;
  constructor(
    private store: FakeStore,
    private op: 'insert' | 'update' | 'select',
    private payload: Record<string, unknown> | undefined
  ) {}

  insert(payload: Record<string, unknown>): FakeBuilder {
    return new FakeBuilder(this.store, 'insert', payload);
  }
  update(payload: Record<string, unknown>): FakeBuilder {
    return new FakeBuilder(this.store, 'update', payload);
  }
  select(cols?: string): FakeBuilder {
    this.selectCols = cols ?? '*';
    return this;
  }
  single(): FakeBuilder {
    this.isSingle = true;
    return this;
  }
  eq(col: string, val: unknown): FakeBuilder {
    this.filters.push({ op: 'eq', col, val });
    return this;
  }
  lt(col: string, val: unknown): FakeBuilder {
    this.filters.push({ op: 'lt', col, val });
    return this;
  }

  private matches(row: RunLogRow): boolean {
    return this.filters.every((f) => {
      const v = row[f.col];
      if (f.op === 'eq') return v === f.val;
      if (f.op === 'lt') return typeof v === 'string' && typeof f.val === 'string' && v < f.val;
      return true;
    });
  }

  private execute(): { data: unknown; error: { code?: string; message: string } | null } {
    if (this.op === 'insert' && this.payload) {
      const p = this.payload;
      if (p.status === 'running') {
        const conflict = this.store.rows.find(
          (r) => r.run_date === p.run_date && r.job_name === p.job_name && r.status === 'running'
        );
        if (conflict) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
        }
      }
      const id = this.store.nextId++;
      const newRow: RunLogRow = {
        id,
        run_date: String(p.run_date ?? ''),
        job_name: String(p.job_name ?? ''),
        status: String(p.status ?? ''),
        forced: Boolean(p.forced ?? false),
        details: p.details ?? {},
        duration_ms: typeof p.duration_ms === 'number' ? p.duration_ms : null,
        ran_at: typeof p.ran_at === 'string' ? p.ran_at : new Date().toISOString(),
        finished_at: typeof p.finished_at === 'string' ? p.finished_at : null
      };
      this.store.rows.push(newRow);
      if (this.selectCols && this.isSingle) return { data: { id }, error: null };
      return { data: null, error: null };
    }
    if (this.op === 'update' && this.payload) {
      for (const row of this.store.rows) {
        if (this.matches(row)) Object.assign(row, this.payload);
      }
      return { data: null, error: null };
    }
    return { data: null, error: { message: 'unsupported op' } };
  }

  then<TResult1 = { data: unknown; error: unknown }>(
    onFulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null
  ): Promise<TResult1> {
    return Promise.resolve(this.execute()).then(onFulfilled ?? ((v) => v as unknown as TResult1));
  }
}

const store = new FakeStore();

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: () => new FakeBuilder(store, 'select', undefined)
  })
}));

vi.mock('@/lib/utils/dates', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils/dates')>('@/lib/utils/dates');
  return {
    ...actual,
    todayInNewYork: () => '2026-05-11'
  };
});

const { JobLockedError, withRunLog } = await import('./run-log');

beforeEach(() => {
  store.rows = [];
  store.nextId = 1;
});

afterEach(() => {
  vi.useRealTimers();
});

function runningRows() {
  return store.rows.filter((r) => r.status === 'running');
}

describe('withRunLog lock lifecycle', () => {
  it('inserts a running row, runs the work, then marks success', async () => {
    const result = await withRunLog('test_job', { runDate: '2026-05-11' }, async () => 'ok');
    expect(result).toBe('ok');
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].status).toBe('success');
    expect(store.rows[0].finished_at).not.toBeNull();
    expect(store.rows[0].forced).toBe(false);
  });

  it('marks the row failed when the work throws and rethrows the original error', async () => {
    await expect(
      withRunLog('test_job', { runDate: '2026-05-11' }, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].status).toBe('failed');
    expect((store.rows[0].details as Record<string, unknown>).error).toBe('boom');
  });

  it('demotes to partial when the result includes a notSettled marker', async () => {
    const result = await withRunLog('screener', { runDate: '2026-05-11' }, async () => ({
      runDate: '2026-05-11',
      notSettled: { dataDate: '2026-05-08' }
    }));
    expect(result.notSettled).toBeDefined();
    expect(store.rows[0].status).toBe('partial');
  });

  it('demotes to partial when the result has a non-empty errors array', async () => {
    await withRunLog('outcome_tracker', { runDate: '2026-05-11' }, async () => ({
      errors: [{ ticker: 'AAPL', message: 'bad' }]
    }));
    expect(store.rows[0].status).toBe('partial');
  });

  it('refuses to start a second run while one is already running and writes a skipped row', async () => {
    let release: () => void = () => undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withRunLog('test_job', { runDate: '2026-05-11' }, async () => {
      await blocker;
      return 'first';
    });

    // Second invocation should reject with JobLockedError.
    await expect(
      withRunLog('test_job', { runDate: '2026-05-11' }, async () => 'second')
    ).rejects.toBeInstanceOf(JobLockedError);

    expect(store.rows.some((r) => r.status === 'skipped')).toBe(true);
    expect(runningRows()).toHaveLength(1);

    release();
    await first;
    expect(runningRows()).toHaveLength(0);
    const final = store.rows.find((r) => r.status === 'success');
    expect(final).toBeDefined();
  });

  it('force=true supersedes the prior running row and runs to completion', async () => {
    let release: () => void = () => undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withRunLog('test_job', { runDate: '2026-05-11' }, async () => {
      await blocker;
      return 'first';
    }).catch(() => 'first-suppressed');

    await new Promise((r) => setImmediate(r));

    const second = await withRunLog('test_job', { runDate: '2026-05-11', force: true }, async () => 'second');
    expect(second).toBe('second');

    const supersededRow = store.rows.find(
      (r) => r.status === 'failed' && (r.details as Record<string, unknown>).reason === 'superseded_by_force'
    );
    expect(supersededRow).toBeDefined();

    release();
    await first;

    const successRows = store.rows.filter((r) => r.status === 'success');
    expect(successRows).toHaveLength(1);
    expect(successRows[0].forced).toBe(true);
  });

  it('reaps a stale running row before acquiring the lock', async () => {
    const stalenessMs = 600_000;
    const oldTime = new Date(Date.now() - stalenessMs - 60_000).toISOString();
    store.rows.push({
      id: store.nextId++,
      run_date: '2026-05-11',
      job_name: 'test_job',
      status: 'running',
      forced: false,
      details: {},
      duration_ms: null,
      ran_at: oldTime,
      finished_at: null
    });

    const result = await withRunLog(
      'test_job',
      { runDate: '2026-05-11', staleAfterMs: stalenessMs },
      async () => 'fresh'
    );
    expect(result).toBe('fresh');

    const reaped = store.rows.find(
      (r) =>
        r.ran_at === oldTime &&
        r.status === 'failed' &&
        (r.details as Record<string, unknown>).reason === 'stale_lock_reaped'
    );
    expect(reaped).toBeDefined();
    expect(store.rows.filter((r) => r.status === 'success')).toHaveLength(1);
  });

  it('does NOT reap a fresh running row and refuses without force', async () => {
    const freshTime = new Date(Date.now() - 1_000).toISOString();
    store.rows.push({
      id: store.nextId++,
      run_date: '2026-05-11',
      job_name: 'test_job',
      status: 'running',
      forced: false,
      details: {},
      duration_ms: null,
      ran_at: freshTime,
      finished_at: null
    });

    await expect(
      withRunLog('test_job', { runDate: '2026-05-11', staleAfterMs: 600_000 }, async () => 'should-not-run')
    ).rejects.toBeInstanceOf(JobLockedError);
  });
});
