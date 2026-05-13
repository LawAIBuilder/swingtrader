import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub run-log so tests don't need Supabase. withRunLog just calls the body.
vi.mock('@/lib/run-log', () => ({
  withRunLog: async <T,>(_jobName: string, _opts: unknown, fn: () => Promise<T>): Promise<T> => fn(),
  JobLockedError: class JobLockedError extends Error {
    readonly name = 'JobLockedError';
  }
}));

// Stub env so tests can swap broker mode without touching process.env globally.
vi.mock('@/lib/env', () => ({
  env: { brokerMode: 'paper' }
}));

const reconcileMock = vi.fn();
const snapshotMock = vi.fn();
vi.mock('@/lib/broker/reconcile', () => ({
  reconcileBrokerOrders: (...args: unknown[]) => reconcileMock(...args),
  snapshotBrokerPositions: (...args: unknown[]) => snapshotMock(...args)
}));

const { runBrokerReconJob } = await import('./broker-recon');
const envMod = await import('@/lib/env');

describe('runBrokerReconJob', () => {
  beforeEach(() => {
    reconcileMock.mockReset();
    snapshotMock.mockReset();
    (envMod.env as { brokerMode: string }).brokerMode = 'paper';
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('short-circuits when broker mode is disabled', async () => {
    (envMod.env as { brokerMode: string }).brokerMode = 'disabled';
    const r = await runBrokerReconJob();
    expect(r.brokerMode).toBe('disabled');
    expect(r.notes[0]).toMatch(/disabled/);
    expect(reconcileMock).not.toHaveBeenCalled();
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it('returns inconclusive=true when reconcile throws but still snapshots positions', async () => {
    reconcileMock.mockRejectedValueOnce(new Error('alpaca 503'));
    snapshotMock.mockResolvedValueOnce({ snapshotted: 0, errors: [] });
    const r = await runBrokerReconJob();
    expect(r.inconclusive).toBe(true);
    expect(r.orderRecon).toBeNull();
    expect(r.positionSnapshot).not.toBeNull();
    expect(r.errors.some((e) => e.stage === 'recon:exception')).toBe(true);
  });

  it('returns inconclusive=true when snapshot throws but reconcile completes', async () => {
    reconcileMock.mockResolvedValueOnce({ checked: 5, errors: [], inconclusive: false });
    snapshotMock.mockRejectedValueOnce(new Error('alpaca 504'));
    const r = await runBrokerReconJob();
    expect(r.inconclusive).toBe(true);
    expect(r.orderRecon).not.toBeNull();
    expect(r.positionSnapshot).toBeNull();
    expect(r.errors.some((e) => e.stage === 'position:exception')).toBe(true);
  });

  it('propagates orderRecon.inconclusive=true through to the job result', async () => {
    reconcileMock.mockResolvedValueOnce({ checked: 0, errors: [], inconclusive: true });
    snapshotMock.mockResolvedValueOnce({ snapshotted: 0, errors: [] });
    const r = await runBrokerReconJob();
    expect(r.inconclusive).toBe(true);
  });

  it('flattens per-order and per-position soft errors', async () => {
    reconcileMock.mockResolvedValueOnce({
      checked: 2,
      errors: [{ idempotencyKey: 'bt:pt:1:entry', message: 'broker 404' }],
      inconclusive: false
    });
    snapshotMock.mockResolvedValueOnce({
      snapshotted: 1,
      errors: [{ ticker: 'AAPL', message: 'no position' }]
    });
    const r = await runBrokerReconJob();
    expect(r.errors).toEqual(
      expect.arrayContaining([
        { stage: 'recon:bt:pt:1:entry', message: 'broker 404' },
        { stage: 'position:AAPL', message: 'no position' }
      ])
    );
    expect(r.inconclusive).toBe(false);
  });
});
