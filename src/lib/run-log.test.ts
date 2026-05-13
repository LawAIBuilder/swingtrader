import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fake Supabase that emulates the partial unique index on
// run_logs(run_date, job_name) WHERE status='running'.
// Just enough to exercise the run-lock state machine end-to-end.

interface RunLogRow {
  id: number;
  run_date: string;
  job_name: string;
  status: 'running' | 'success' | 'partial' | 'failed' | 'skipped';
  forced: boolean;
  details: unknown;
  ran_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

const PG_UNIQUE_VIOLATION = '23505';

let rows: RunLogRow[] = [];
let nextId = 1;
// Allow tests to control "now" for ran_at age / stale-reap window.
let nowOverride: number | null = null;

function makeNowIso(): string {
  return new Date(nowOverride ?? Date.now()).toISOString();
}

interface InsertResult {
  data: { id: number } | null;
  error: { code?: string; message: string } | null;
}

interface UpdateChain {
  data: null;
  error: { code?: string; message: string } | null;
}

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from(table: string) {
      if (table !== 'run_logs') {
        throw new Error(`unexpected table ${table}`);
      }
      return {
        insert(payload: Partial<RunLogRow>) {
          const candidate: RunLogRow = {
            id: nextId++,
            run_date: payload.run_date as string,
            job_name: payload.job_name as string,
            status: (payload.status as RunLogRow['status']) ?? 'running',
            forced: payload.forced ?? false,
            details: payload.details ?? {},
            ran_at: makeNowIso(),
            finished_at: payload.finished_at ?? null,
            duration_ms: payload.duration_ms ?? null
          };
          // Enforce partial unique index for status='running'.
          if (candidate.status === 'running') {
            const conflict = rows.find(
              (r) => r.run_date === candidate.run_date && r.job_name === candidate.job_name && r.status === 'running'
            );
            if (conflict) {
              const result: InsertResult = {
                data: null,
                error: { code: PG_UNIQUE_VIOLATION, message: 'duplicate key value violates unique constraint' }
              };
              return {
                select: () => ({
                  single: async () => result
                }),
                then: (resolve: (v: { error: { code?: string; message: string } | null }) => unknown) =>
                  resolve({ error: result.error })
              };
            }
          }
          rows.push(candidate);
          const result: InsertResult = { data: { id: candidate.id }, error: null };
          return {
            select: () => ({
              single: async () => result
            }),
            then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null })
          };
        },
        update(updates: Partial<RunLogRow>) {
          // Build a fluent chain that collects predicates.
          const filters: Array<(r: RunLogRow) => boolean> = [];
          const chain = {
            eq(col: keyof RunLogRow, val: unknown) {
              filters.push((r) => r[col] === val);
              return chain;
            },
            lt(col: keyof RunLogRow, val: unknown) {
              filters.push((r) => (r[col] as string) < (val as string));
              return chain;
            },
            then(resolve: (v: UpdateChain) => unknown) {
              const matches = rows.filter((r) => filters.every((f) => f(r)));
              for (const m of matches) Object.assign(m, updates);
              return resolve({ data: null, error: null });
            }
          };
          return chain;
        }
      };
    }
  })
}));

const { withRunLog, JobLockedError } = await import('./run-log');

describe('withRunLog (run-lock state machine)', () => {
  beforeEach(() => {
    rows = [];
    nextId = 1;
    nowOverride = null;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('writes a running row, then a success row, on the happy path', async () => {
    const result = await withRunLog('screener', { runDate: '2026-05-11' }, async () => ({ ok: true }));
    expect(result).toEqual({ ok: true });
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('success');
    expect(rows[0].duration_ms).toBeGreaterThanOrEqual(0);
    expect(rows[0].forced).toBe(false);
  });

  it('refuses a concurrent run with JobLockedError and writes a skipped row', async () => {
    let release!: () => void;
    const blocker = new Promise<void>((res) => {
      release = res;
    });
    const first = withRunLog('screener', { runDate: '2026-05-11' }, async () => {
      await blocker;
      return { ok: true };
    });
    // Give the first call a microtask to acquire the lock.
    await Promise.resolve();
    await Promise.resolve();
    await expect(
      withRunLog('screener', { runDate: '2026-05-11' }, async () => ({ ok: true }))
    ).rejects.toBeInstanceOf(JobLockedError);
    release();
    await first;
    const skipped = rows.find((r) => r.status === 'skipped');
    expect(skipped).toBeDefined();
    expect(skipped?.forced).toBe(false);
  });

  it('force=true supersedes a prior running row and writes a new force row', async () => {
    let release!: () => void;
    const blocker = new Promise<void>((res) => {
      release = res;
    });
    const first = withRunLog('screener', { runDate: '2026-05-11' }, async () => {
      await blocker;
      return { ok: true };
    });
    await Promise.resolve();
    await Promise.resolve();

    const forced = withRunLog('screener', { runDate: '2026-05-11', force: true }, async () => ({ forced: true }));
    await Promise.resolve();
    await Promise.resolve();

    release();
    await first;
    const finalForced = await forced;
    expect(finalForced).toEqual({ forced: true });

    const supersededOriginals = rows.filter(
      (r) => r.status === 'failed' && (r.details as { reason?: string }).reason === 'superseded_by_force'
    );
    expect(supersededOriginals.length).toBe(1);
    const successForced = rows.find((r) => r.status === 'success' && r.forced === true);
    expect(successForced).toBeDefined();
  });

  it('reaps a stale running row before acquiring', async () => {
    // Seed a stale running row directly.
    nowOverride = Date.UTC(2026, 4, 11, 12, 0, 0);
    rows.push({
      id: nextId++,
      run_date: '2026-05-11',
      job_name: 'screener',
      status: 'running',
      forced: false,
      details: {},
      ran_at: new Date(nowOverride - 60 * 60_000).toISOString(),
      finished_at: null,
      duration_ms: null
    });

    const result = await withRunLog(
      'screener',
      { runDate: '2026-05-11', staleAfterMs: 5 * 60_000 },
      async () => ({ reaped: true })
    );
    expect(result).toEqual({ reaped: true });

    // Stale row should now be marked failed/stale_lock_reaped.
    const reaped = rows.find(
      (r) => r.status === 'failed' && (r.details as { reason?: string }).reason === 'stale_lock_reaped'
    );
    expect(reaped).toBeDefined();

    // And the new run completed successfully.
    const newSuccess = rows.find((r) => r.status === 'success');
    expect(newSuccess).toBeDefined();
  });

  it('marks the row failed when the job throws', async () => {
    await expect(
      withRunLog('screener', { runDate: '2026-05-11' }, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('failed');
    expect((rows[0].details as { error?: string }).error).toBe('boom');
  });

  it('demotes to partial when the result has notSettled', async () => {
    await withRunLog('screener', { runDate: '2026-05-11' }, async () => ({ notSettled: '2026-05-10' }));
    expect(rows[0].status).toBe('partial');
  });

  it('demotes to partial when the result has errors[]', async () => {
    await withRunLog('outcomes', { runDate: '2026-05-11' }, async () => ({ errors: ['one_failure'] }));
    expect(rows[0].status).toBe('partial');
  });
});
