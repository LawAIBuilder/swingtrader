import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory fake of the broker_orders slice of the Supabase client. We model
// only what submitOrderIdempotent touches: select+maybeSingle on
// idempotency_key, insert+select+single, update+eq, and most importantly the
// 23505 unique-violation that the partial UNIQUE(idempotency_key) constraint
// produces in production when two callers race past the SELECT branch.

interface BrokerOrderRow {
  id: number;
  idempotency_key: string;
  status: string;
  broker_order_id: string | null;
  filled_quantity: number;
  avg_fill_price: number | null;
  reconciliation_status: string;
  last_error?: string | null;
  [key: string]: unknown;
}

class FakeStore {
  rows: BrokerOrderRow[] = [];
  nextId = 1;
  // When > 0, the next insert succeeds normally. When 0, the next insert
  // simulates a unique-violation but ALSO inserts the row so the recovery
  // SELECT finds it. This models a race where a sibling caller already won
  // the INSERT.
  insertsToReject = 0;
}

const store = new FakeStore();

class FakeBuilder {
  private filters: Array<{ col: string; val: unknown }> = [];
  private isSingle = false;
  private selectCols: string | null = null;
  constructor(
    private op: 'insert' | 'update' | 'select',
    private payload: Record<string, unknown> | null = null
  ) {}
  insert(p: Record<string, unknown>): FakeBuilder {
    return new FakeBuilder('insert', p);
  }
  update(p: Record<string, unknown>): FakeBuilder {
    return new FakeBuilder('update', p);
  }
  select(cols?: string): FakeBuilder {
    this.selectCols = cols ?? '*';
    return this;
  }
  maybeSingle() {
    return this.run();
  }
  single() {
    this.isSingle = true;
    return this.run();
  }
  eq(col: string, val: unknown): FakeBuilder {
    this.filters.push({ col, val });
    return this;
  }

  // supabase-js builders are thenable: `await chain` triggers the request
  // when neither single() nor maybeSingle() was called. Mirror that here so
  // bare `await supabase.from().update().eq()` runs the update.
  then<TResult1>(onFulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null): Promise<TResult1> {
    return Promise.resolve(this.run()).then(onFulfilled ?? ((v) => v as unknown as TResult1));
  }

  private run() {
    if (this.op === 'select') {
      const found = store.rows.find((r) => this.filters.every((f) => r[f.col] === f.val));
      return Promise.resolve({ data: found ?? null, error: null });
    }
    if (this.op === 'insert' && this.payload) {
      if (store.insertsToReject > 0) {
        store.insertsToReject -= 1;
        // Simulate the race: insert the row anyway (as the sibling caller
        // would have done), then return 23505 to this caller.
        const row = this.materialize(this.payload);
        store.rows.push(row);
        return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } });
      }
      const row = this.materialize(this.payload);
      store.rows.push(row);
      return Promise.resolve({ data: this.isSingle ? { id: row.id } : null, error: null });
    }
    if (this.op === 'update' && this.payload) {
      for (const row of store.rows) {
        if (this.filters.every((f) => row[f.col] === f.val)) {
          Object.assign(row, this.payload);
        }
      }
      return Promise.resolve({ data: null, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  }

  private materialize(p: Record<string, unknown>): BrokerOrderRow {
    return {
      id: store.nextId++,
      idempotency_key: String(p.idempotency_key ?? ''),
      status: String(p.status ?? 'pending_submit'),
      broker_order_id: (p.broker_order_id as string) ?? null,
      filled_quantity: typeof p.filled_quantity === 'number' ? p.filled_quantity : 0,
      avg_fill_price: typeof p.avg_fill_price === 'number' ? p.avg_fill_price : null,
      reconciliation_status: String(p.reconciliation_status ?? 'pending'),
      ...p
    } as BrokerOrderRow;
  }
}

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: () => new FakeBuilder('select')
  })
}));

vi.mock('@/lib/broker/provider', () => ({
  getBrokerClient: () => ({
    name: 'mock' as const,
    isLiveCapable: false,
    submitOrder: vi.fn().mockResolvedValue({
      brokerOrderId: 'MOCK-1',
      status: 'filled' as const,
      filledQuantity: 5,
      avgFillPrice: 100
    }),
    cancelOrder: vi.fn(),
    cancelAllOrders: vi.fn(),
    getOrder: vi.fn(),
    listOrdersSince: vi.fn(),
    listPositions: vi.fn()
  })
}));

const { submitOrderIdempotent } = await import('./submit');

beforeEach(() => {
  store.rows = [];
  store.nextId = 1;
  store.insertsToReject = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('submitOrderIdempotent', () => {
  it('happy path: inserts pending_submit, calls broker, updates to filled', async () => {
    const out = await submitOrderIdempotent({
      paperTradeId: 1,
      order: {
        idempotencyKey: 'bt:pt:1:entry',
        ticker: 'AAPL',
        side: 'buy',
        type: 'market',
        quantity: 5
      }
    });
    expect(out.ok).toBe(true);
    expect(out.reused).toBe(false);
    expect(out.status).toBe('filled');
    expect(out.brokerOrderId).toBe('MOCK-1');
    // Should be exactly one row in the table.
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].status).toBe('filled');
  });

  it('reused path: existing row with same idempotency_key returned without re-submitting', async () => {
    // Pre-populate a successful row.
    store.rows.push({
      id: 99,
      idempotency_key: 'bt:pt:5:entry',
      status: 'filled',
      broker_order_id: 'MOCK-OLD',
      filled_quantity: 5,
      avg_fill_price: 100,
      reconciliation_status: 'matched'
    });
    const out = await submitOrderIdempotent({
      paperTradeId: 5,
      order: {
        idempotencyKey: 'bt:pt:5:entry',
        ticker: 'AAPL',
        side: 'buy',
        type: 'market',
        quantity: 5
      }
    });
    expect(out.reused).toBe(true);
    expect(out.brokerOrderId).toBe('MOCK-OLD');
    expect(out.status).toBe('filled');
    // No new row should have been inserted.
    expect(store.rows).toHaveLength(1);
  });

  it('race recovery: SELECT misses, INSERT hits 23505, recovery SELECT finds the sibling row', async () => {
    store.insertsToReject = 1;
    const out = await submitOrderIdempotent({
      paperTradeId: 7,
      order: {
        idempotencyKey: 'bt:pt:7:entry',
        ticker: 'AAPL',
        side: 'buy',
        type: 'market',
        quantity: 5
      }
    });
    // Without the recovery branch this would have been ok=false / reused=false
    // with error="insert_failed:duplicate key". With recovery it should appear
    // as reused (the sibling already inserted it).
    expect(out.reused).toBe(true);
    expect(out.error).toBeNull();
    // Sibling-inserted row is still pending_submit (broker call was deferred to
    // the sibling), but our caller should report it as the row it sees.
    expect(out.status).toBe('pending_submit');
    // Exactly one row exists for the idempotency key.
    const matching = store.rows.filter((r) => r.idempotency_key === 'bt:pt:7:entry');
    expect(matching).toHaveLength(1);
  });
});
