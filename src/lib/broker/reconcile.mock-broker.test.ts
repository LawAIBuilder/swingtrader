import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockBrokerClient } from './mock';

// Integration-style test that wires the *real* MockBrokerClient into the
// reconcile path, instead of stubbing the broker surface with vi.fn(). The
// previous tests verified the inconclusive guard and the bulk-fallback paths
// against a hand-rolled stub, but they don't catch a regression where the
// MockBrokerClient itself drifts away from the BrokerClient contract.

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
  positionSnapshots: Array<Record<string, unknown>> = [];
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
  private op: 'select' | 'update' | 'insert' = 'select';
  private payload: Record<string, unknown> | Array<Record<string, unknown>> | null = null;
  private filters: FilterCond[] = [];
  private orFilters: FilterCond[] | null = null;
  constructor(private readonly table: string) {}
  select(_cols?: string) {
    return this;
  }
  insert(payload: Record<string, unknown> | Array<Record<string, unknown>>) {
    this.op = 'insert';
    this.payload = payload;
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
    this.orFilters = parts.map(parseOrPart).filter((p): p is FilterCond => p !== null);
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
    if (this.table === 'broker_positions' && this.op === 'insert') {
      const payload = Array.isArray(this.payload) ? this.payload : [this.payload as Record<string, unknown>];
      store.positionSnapshots.push(...payload);
      return { data: null, error: null };
    }
    if (this.op === 'select') {
      const rows = store.rows.filter((r) => this.rowMatches(r));
      return { data: rows, error: null };
    }
    if (this.op === 'update' && this.payload && !Array.isArray(this.payload)) {
      const payload = this.payload as Record<string, unknown>;
      for (const row of store.rows) {
        if (this.rowMatches(row)) {
          Object.assign(row, payload);
        }
      }
      return { data: null, error: null };
    }
    return { data: null, error: null };
  }
}

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({ from: (table: string) => new FakeBuilder(table) })
}));

const broker = new MockBrokerClient();
vi.mock('@/lib/broker/provider', () => ({
  getBrokerClient: () => broker
}));

const { reconcileBrokerOrders, snapshotBrokerPositions } = await import('./reconcile');

beforeEach(() => {
  store.rows = [];
  store.positionSnapshots = [];
  broker.__reset();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('reconcile against real MockBrokerClient', () => {
  it('matches a local row against a freshly-submitted mock order', async () => {
    // 1. Place an order through the real mock client. It fills instantly.
    const submitted = await broker.submitOrder({
      idempotencyKey: 'bt:pt:50:entry',
      ticker: 'AAPL',
      side: 'buy',
      type: 'limit',
      quantity: 10,
      limitPrice: 150
    });
    expect(submitted.status).toBe('filled');
    expect(submitted.filledQuantity).toBe(10);

    // 2. Insert a local row that mirrors what submit-order writes after
    // calling broker.submitOrder. We carry status='filled' to test the
    // "matched" path; submit's responsibility (separately tested) is to
    // write that initial state.
    store.rows.push({
      id: 50,
      idempotency_key: submitted.brokerOrderId === '' ? 'bt:pt:50:entry' : 'bt:pt:50:entry',
      broker: 'mock',
      broker_order_id: submitted.brokerOrderId,
      ticker: 'AAPL',
      status: 'filled',
      filled_quantity: 10,
      avg_fill_price: 150,
      reconciliation_status: 'pending',
      created_at: new Date().toISOString()
    });

    const out = await reconcileBrokerOrders(new Date(Date.now() - 60_000).toISOString());

    expect(out.inconclusive).toBeUndefined();
    expect(out.ordersChecked).toBe(1);
    expect(out.matched).toBe(1);
    expect(out.mismatch).toBe(0);
    expect(out.brokerUnknown).toBe(0);
    expect(out.orphanLocal).toBe(0);
    expect(store.rows[0].reconciliation_status).toBe('matched');
  });

  it('snapshots the broker position book through the real mock client', async () => {
    await broker.submitOrder({
      idempotencyKey: 'bt:pt:51:entry',
      ticker: 'MSFT',
      side: 'buy',
      type: 'limit',
      quantity: 5,
      limitPrice: 400
    });
    await broker.submitOrder({
      idempotencyKey: 'bt:pt:52:entry',
      ticker: 'GOOG',
      side: 'buy',
      type: 'limit',
      quantity: 2,
      limitPrice: 175
    });

    const out = await snapshotBrokerPositions();
    expect(out.positions).toBe(2);
    expect(out.errors).toEqual([]);
    const tickers = store.positionSnapshots.map((r) => r.ticker).sort();
    expect(tickers).toEqual(['GOOG', 'MSFT']);
  });

  it('idempotent submit returns the same broker order id on duplicate calls', async () => {
    const first = await broker.submitOrder({
      idempotencyKey: 'bt:pt:99:entry',
      ticker: 'NVDA',
      side: 'buy',
      type: 'limit',
      quantity: 1,
      limitPrice: 500
    });
    const second = await broker.submitOrder({
      idempotencyKey: 'bt:pt:99:entry',
      ticker: 'NVDA',
      side: 'buy',
      type: 'limit',
      quantity: 1,
      limitPrice: 500
    });
    expect(first.brokerOrderId).toBe(second.brokerOrderId);
  });
});
