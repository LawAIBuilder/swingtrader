import type {
  BrokerClient,
  BrokerOrderSnapshot,
  BrokerPositionSnapshot,
  SubmitOrderInput,
  SubmitOrderResult
} from './client';

// Deterministic in-memory broker for unit tests and dev. Every order fills
// instantly at limit_price (or stop_price for stops) and updates an internal
// position book. Designed to expose the same surface AlpacaPaperBrokerClient
// exposes so reconciliation logic can be exercised end-to-end without network.

interface MockOrder extends BrokerOrderSnapshot {
  type: 'market' | 'limit' | 'stop' | 'bracket';
  quantity: number;
}

export class MockBrokerClient implements BrokerClient {
  readonly name = 'mock' as const;
  readonly isLiveCapable = false;

  // Maps broker_order_id -> snapshot.
  private orders = new Map<string, MockOrder>();
  // Maps idempotency key -> broker_order_id, so a duplicate submitOrder
  // returns the existing order instead of double-filling.
  private byIdempotency = new Map<string, string>();
  private positions = new Map<string, BrokerPositionSnapshot>();
  private seq = 0;

  async submitOrder(input: SubmitOrderInput): Promise<SubmitOrderResult> {
    const existingId = this.byIdempotency.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.orders.get(existingId);
      if (existing) {
        return {
          brokerOrderId: existing.brokerOrderId,
          status: existing.status,
          filledQuantity: existing.filledQuantity,
          avgFillPrice: existing.avgFillPrice,
          raw: existing.raw
        };
      }
    }

    this.seq += 1;
    const brokerOrderId = `MOCK-${this.seq}`;
    const fillPrice = input.limitPrice ?? input.stopPrice ?? 100;
    const now = new Date().toISOString();
    const snapshot: MockOrder = {
      brokerOrderId,
      idempotencyKey: input.idempotencyKey,
      ticker: input.ticker,
      side: input.side,
      type: input.type,
      quantity: input.quantity,
      status: 'filled',
      filledQuantity: input.quantity,
      avgFillPrice: fillPrice,
      submittedAt: now,
      filledAt: now
    };
    this.orders.set(brokerOrderId, snapshot);
    this.byIdempotency.set(input.idempotencyKey, brokerOrderId);

    const sign = input.side === 'buy' ? 1 : -1;
    const existing = this.positions.get(input.ticker);
    const totalQty = (existing?.quantity ?? 0) + sign * input.quantity;
    if (totalQty === 0) {
      this.positions.delete(input.ticker);
    } else {
      this.positions.set(input.ticker, {
        ticker: input.ticker,
        quantity: totalQty,
        avgEntryPrice: fillPrice,
        marketValue: totalQty * fillPrice,
        unrealizedPl: 0
      });
    }

    return {
      brokerOrderId,
      status: 'filled',
      filledQuantity: input.quantity,
      avgFillPrice: fillPrice
    };
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    const order = this.orders.get(brokerOrderId);
    if (!order) return;
    if (order.status === 'filled' || order.status === 'canceled') return;
    order.status = 'canceled';
    order.canceledAt = new Date().toISOString();
  }

  async cancelAllOrders(): Promise<{ canceledCount: number }> {
    let count = 0;
    for (const o of this.orders.values()) {
      if (o.status === 'pending_submit' || o.status === 'submitted' || o.status === 'partially_filled') {
        o.status = 'canceled';
        o.canceledAt = new Date().toISOString();
        count += 1;
      }
    }
    return { canceledCount: count };
  }

  async getOrder(brokerOrderId: string): Promise<BrokerOrderSnapshot | null> {
    return this.orders.get(brokerOrderId) ?? null;
  }

  async listOrdersSince(_iso: string): Promise<BrokerOrderSnapshot[]> {
    return Array.from(this.orders.values());
  }

  async listPositions(): Promise<BrokerPositionSnapshot[]> {
    return Array.from(this.positions.values());
  }

  // Test helper. Not part of the BrokerClient interface.
  __reset(): void {
    this.orders.clear();
    this.byIdempotency.clear();
    this.positions.clear();
    this.seq = 0;
  }
}
