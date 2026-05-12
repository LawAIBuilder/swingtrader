import { beforeEach, describe, expect, it } from 'vitest';
import { MockBrokerClient } from './mock';
import { entryKeyForPaperTrade, exitKeyForPaperTrade } from './idempotency';
import { BrokerDisabledError } from './client';
import { DisabledBrokerClient } from './disabled';

describe('MockBrokerClient', () => {
  let client: MockBrokerClient;
  beforeEach(() => {
    client = new MockBrokerClient();
  });

  it('fills a market order and updates positions', async () => {
    const out = await client.submitOrder({
      idempotencyKey: entryKeyForPaperTrade(1),
      ticker: 'AAPL',
      side: 'buy',
      type: 'market',
      quantity: 10,
      limitPrice: 150
    });
    expect(out.status).toBe('filled');
    expect(out.filledQuantity).toBe(10);
    expect(out.avgFillPrice).toBe(150);
    const positions = await client.listPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].ticker).toBe('AAPL');
    expect(positions[0].quantity).toBe(10);
  });

  it('returns the same order on duplicate submission with the same idempotency key', async () => {
    const key = entryKeyForPaperTrade(2);
    const a = await client.submitOrder({
      idempotencyKey: key,
      ticker: 'MSFT',
      side: 'buy',
      type: 'market',
      quantity: 5,
      limitPrice: 200
    });
    const b = await client.submitOrder({
      idempotencyKey: key,
      ticker: 'MSFT',
      side: 'buy',
      type: 'market',
      quantity: 5,
      limitPrice: 999
    });
    expect(b.brokerOrderId).toBe(a.brokerOrderId);
    expect(b.avgFillPrice).toBe(150 + 50);
    const positions = await client.listPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].quantity).toBe(5);
  });

  it('reduces position to zero when sold', async () => {
    await client.submitOrder({
      idempotencyKey: entryKeyForPaperTrade(3),
      ticker: 'NVDA',
      side: 'buy',
      type: 'market',
      quantity: 3,
      limitPrice: 400
    });
    await client.submitOrder({
      idempotencyKey: exitKeyForPaperTrade(3, 'target'),
      ticker: 'NVDA',
      side: 'sell',
      type: 'market',
      quantity: 3,
      limitPrice: 410
    });
    const positions = await client.listPositions();
    expect(positions).toHaveLength(0);
  });

  it('cancelAllOrders cancels only pending orders', async () => {
    const out = await client.cancelAllOrders();
    // Mock fills instantly so no orders are pending at this point.
    expect(out.canceledCount).toBe(0);
  });

  it('lists orders since an arbitrary iso timestamp', async () => {
    await client.submitOrder({
      idempotencyKey: entryKeyForPaperTrade(4),
      ticker: 'TSLA',
      side: 'buy',
      type: 'market',
      quantity: 1,
      limitPrice: 100
    });
    const orders = await client.listOrdersSince('1970-01-01T00:00:00Z');
    expect(orders.length).toBeGreaterThan(0);
  });
});

describe('DisabledBrokerClient', () => {
  it('throws on every operation', async () => {
    const disabled = new DisabledBrokerClient();
    await expect(disabled.submitOrder({
      idempotencyKey: 'x',
      ticker: 'X',
      side: 'buy',
      type: 'market',
      quantity: 1
    })).rejects.toBeInstanceOf(BrokerDisabledError);
    await expect(disabled.listOrdersSince('2026-01-01')).rejects.toBeInstanceOf(BrokerDisabledError);
    await expect(disabled.listPositions()).rejects.toBeInstanceOf(BrokerDisabledError);
  });
});
