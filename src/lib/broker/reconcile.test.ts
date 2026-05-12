import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal supabase fake mirroring the slice reconcile uses: select +
// .gte(col, val) returning a static set of local rows, and update + .eq(...)
// applying a partial update. No constraint checks; reconcile doesn't insert.

interface BrokerOrderRow {
  id: number;
  idempotency_key: string;
  broker: string;
  broker_order_id: string | null;
  ticker: string;
  status: string;
  filled_quantity: number;
  avg_fill_price: number | null;
  reconciliation_status: string;
  created_at: string;
  [key: string]: unknown;
}

class FakeStore {
  rows: BrokerOrderRow[] = [];
}
const store = new FakeStore();

type FilterCond = { col: string; op: 'eq' | 'gte'; val: unknown };

function matchCond(row: BrokerOrderRow, f: FilterCond): boolean {
  const v = row[f.col];
  if (f.op === 'eq') return v === f.val;
  if (f.op === 'gte') return typeof v === 'string' && typeof f.val === 'string' && v >= f.val;
  return false;
}

function parseOrPart(part: string): FilterCond | null {
  // PostgREST or() syntax: "col.op.val", e.g. "created_at.gte.2026-05-10..."
  const idx1 = part.indexOf('.');
  if (idx1 < 0) return null;
  const idx2 = part.indexOf('.', idx1 + 1);
  if (idx2 < 0) return null;
  const col = part.slice(0, idx1);
  const op = part.slice(idx1 + 1, idx2);
  const val = part.slice(idx2 + 1);
  if (op !== 'eq' && op !== 'gte') return null;
  return { col, op, val };
}

class FakeBuilder {
  private op: 'select' | 'update' = 'select';
  private payload: Record<string, unknown> | null = null;
  private filters: FilterCond[] = [];
  private orFilters: FilterCond[] | null = null;
  select(_cols: string) {
    return this;
  }
  update(p: Record<string, unknown>) {
    this.op = 'update';
    this.payload = p;
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ col, op: 'eq', val });
    return this;
  }
  gte(col: string, val: unknown) {
    this.filters.push({ col, op: 'gte', val });
    return this;
  }
  or(spec: string) {
    const parts = spec.split(',');
    const parsed = parts.map(parseOrPart).filter((p): p is FilterCond => p !== null);
    this.orFilters = parsed;
    return this;
  }
  then<TResult1>(onFulfilled?: ((v: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null): Promise<TResult1> {
    return Promise.resolve(this.run()).then(onFulfilled ?? ((v) => v as unknown as TResult1));
  }
  private rowMatches(row: BrokerOrderRow): boolean {
    if (!this.filters.every((f) => matchCond(row, f))) return false;
    if (this.orFilters && this.orFilters.length > 0) {
      return this.orFilters.some((f) => matchCond(row, f));
    }
    return true;
  }
  private run(): { data: unknown; error: unknown } {
    if (this.op === 'select') {
      const rows = store.rows.filter((r) => this.rowMatches(r));
      return { data: rows, error: null };
    }
    if (this.op === 'update' && this.payload) {
      for (const row of store.rows) {
        if (this.rowMatches(row)) {
          Object.assign(row, this.payload);
        }
      }
      return { data: null, error: null };
    }
    return { data: null, error: null };
  }
}

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({ from: () => new FakeBuilder() })
}));

const brokerStub = {
  name: 'mock' as const,
  isLiveCapable: false,
  submitOrder: vi.fn(),
  cancelOrder: vi.fn(),
  cancelAllOrders: vi.fn(),
  getOrder: vi.fn(),
  listOrdersSince: vi.fn(),
  listPositions: vi.fn().mockResolvedValue([])
};

vi.mock('@/lib/broker/provider', () => ({
  getBrokerClient: () => brokerStub
}));

const { reconcileBrokerOrders } = await import('./reconcile');

beforeEach(() => {
  store.rows = [];
  brokerStub.listOrdersSince.mockReset();
  brokerStub.listPositions.mockReset();
  brokerStub.listPositions.mockResolvedValue([]);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('reconcileBrokerOrders inconclusive guard', () => {
  it('flags inconclusive when broker call throws and we have local rows', async () => {
    store.rows.push({
      id: 1,
      idempotency_key: 'bt:pt:1:entry',
      broker: 'mock',
      broker_order_id: 'MOCK-1',
      ticker: 'AAPL',
      status: 'submitted',
      filled_quantity: 0,
      avg_fill_price: null,
      reconciliation_status: 'pending',
      created_at: '2026-05-11T00:00:00Z'
    });
    brokerStub.listOrdersSince.mockRejectedValue(new Error('network'));

    const out = await reconcileBrokerOrders('2026-05-10T00:00:00Z');
    expect(out.inconclusive).toBe(true);
    expect(out.orphanLocal).toBe(0);
    expect(out.errors.length).toBeGreaterThan(0);
    // Local rows should NOT have been mutated to orphan_local.
    expect(store.rows[0].reconciliation_status).toBe('pending');
  });

  it('flags inconclusive when broker returns empty but locals exist', async () => {
    store.rows.push({
      id: 2,
      idempotency_key: 'bt:pt:2:entry',
      broker: 'mock',
      broker_order_id: 'MOCK-2',
      ticker: 'MSFT',
      status: 'submitted',
      filled_quantity: 0,
      avg_fill_price: null,
      reconciliation_status: 'pending',
      created_at: '2026-05-11T00:00:00Z'
    });
    brokerStub.listOrdersSince.mockResolvedValue([]);

    const out = await reconcileBrokerOrders('2026-05-10T00:00:00Z');
    expect(out.inconclusive).toBe(true);
    expect(out.orphanLocal).toBe(0);
    expect(store.rows[0].reconciliation_status).toBe('pending');
  });

  it('still reconciles non-terminal local rows even when created before sinceIso', async () => {
    // This is the bug the previous reconcile had: an order submitted 3 days
    // ago that just filled today must be picked up. The old query
    // `.gte('created_at', sinceIso)` would have skipped it.
    store.rows.push({
      id: 99,
      idempotency_key: 'bt:pt:99:entry',
      broker: 'mock',
      broker_order_id: 'MOCK-99',
      ticker: 'AMD',
      status: 'submitted',
      filled_quantity: 0,
      avg_fill_price: null,
      reconciliation_status: 'pending',
      created_at: '2026-05-01T00:00:00Z' // long before sinceIso
    });
    brokerStub.listOrdersSince.mockResolvedValue([
      {
        brokerOrderId: 'MOCK-99',
        idempotencyKey: 'bt:pt:99:entry',
        ticker: 'AMD',
        side: 'buy',
        status: 'filled',
        filledQuantity: 10,
        avgFillPrice: 92,
        submittedAt: '2026-05-01T00:00:00Z',
        filledAt: '2026-05-11T15:30:00Z'
      }
    ]);

    const out = await reconcileBrokerOrders('2026-05-10T00:00:00Z');
    expect(out.inconclusive).toBeUndefined();
    expect(out.ordersChecked).toBe(1);
    expect(store.rows[0].status).toBe('filled');
    expect(store.rows[0].filled_quantity).toBe(10);
  });

  it('falls back to broker.getOrder when bulk listing missed the row', async () => {
    store.rows.push({
      id: 100,
      idempotency_key: 'bt:pt:100:entry',
      broker: 'mock',
      broker_order_id: 'MOCK-100',
      ticker: 'GOOGL',
      status: 'submitted',
      filled_quantity: 0,
      avg_fill_price: null,
      reconciliation_status: 'pending',
      created_at: '2026-05-01T00:00:00Z'
    });
    // Note the bulk list returns a *different* unrelated order, so we don't
    // hit the empty-list inconclusive guard, but our row isn't there.
    brokerStub.listOrdersSince.mockResolvedValue([
      {
        brokerOrderId: 'MOCK-OTHER',
        idempotencyKey: 'unrelated',
        ticker: 'TSLA',
        side: 'buy',
        status: 'filled',
        filledQuantity: 1,
        avgFillPrice: 200
      }
    ]);
    brokerStub.getOrder.mockResolvedValue({
      brokerOrderId: 'MOCK-100',
      idempotencyKey: 'bt:pt:100:entry',
      ticker: 'GOOGL',
      side: 'buy',
      status: 'filled',
      filledQuantity: 3,
      avgFillPrice: 150
    });

    const out = await reconcileBrokerOrders('2026-05-10T00:00:00Z');
    expect(brokerStub.getOrder).toHaveBeenCalledWith('MOCK-100');
    expect(out.brokerUnknown).toBe(0);
    expect(store.rows[0].status).toBe('filled');
    expect(store.rows[0].filled_quantity).toBe(3);
  });

  it('reconciles normally when broker returns a snapshot for the local row', async () => {
    store.rows.push({
      id: 3,
      idempotency_key: 'bt:pt:3:entry',
      broker: 'mock',
      broker_order_id: 'MOCK-3',
      ticker: 'NVDA',
      status: 'submitted',
      filled_quantity: 0,
      avg_fill_price: null,
      reconciliation_status: 'pending',
      created_at: '2026-05-11T00:00:00Z'
    });
    brokerStub.listOrdersSince.mockResolvedValue([
      {
        brokerOrderId: 'MOCK-3',
        idempotencyKey: 'bt:pt:3:entry',
        ticker: 'NVDA',
        side: 'buy',
        status: 'filled',
        filledQuantity: 5,
        avgFillPrice: 100,
        submittedAt: '2026-05-11T00:00:00Z',
        filledAt: '2026-05-11T00:00:01Z'
      }
    ]);
    const out = await reconcileBrokerOrders('2026-05-10T00:00:00Z');
    expect(out.inconclusive).toBeUndefined();
    // Local was submitted/filled_qty=0; broker reports filled/qty=5. That is
    // not "matched" by matchSnapshot (it requires status+qty agreement), so
    // it counts as a mismatch — but importantly the row IS updated to reflect
    // the broker's truth.
    expect(out.matched + out.mismatch).toBe(1);
    expect(store.rows[0].status).toBe('filled');
    expect(store.rows[0].reconciliation_status).toBe('mismatch');
    expect(store.rows[0].filled_quantity).toBe(5);
  });
});
