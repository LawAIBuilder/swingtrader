import { env } from '@/lib/env';
import { timedFetch } from '@/lib/utils/timed-fetch';
import {
  type BrokerClient,
  type BrokerOrderSnapshot,
  type BrokerPositionSnapshot,
  type OrderStatus,
  type SubmitOrderInput,
  type SubmitOrderResult
} from './client';

// Alpaca paper-trading adapter. Hardcoded to ALPACA_PAPER_BASE_URL which
// defaults to https://paper-api.alpaca.markets. Live trading requires a
// different base URL and is intentionally not constructible from this
// adapter.
//
// Idempotency: we pass the application's idempotency key as Alpaca's
// `client_order_id`. Alpaca rejects duplicate submissions with the same
// client_order_id, so retries cannot double-submit even if the network
// dropped between submit and our DB write.

interface AlpacaOrderResponse {
  id: string;
  client_order_id?: string | null;
  symbol: string;
  side: 'buy' | 'sell';
  status: string;
  filled_qty: string | number | null;
  filled_avg_price: string | number | null;
  submitted_at?: string;
  filled_at?: string;
  canceled_at?: string;
}

interface AlpacaPositionResponse {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  market_value: string;
  unrealized_pl: string;
}

function statusFromAlpaca(s: string): OrderStatus {
  switch (s) {
    case 'new':
    case 'accepted':
    case 'pending_new':
    case 'accepted_for_bidding':
      return 'submitted';
    case 'partially_filled':
      return 'partially_filled';
    case 'filled':
      return 'filled';
    case 'canceled':
    case 'pending_cancel':
      return 'canceled';
    case 'rejected':
      return 'rejected';
    case 'expired':
      return 'expired';
    default:
      return 'unknown';
  }
}

function n(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const v = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(v) ? v : 0;
}

function nMaybe(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const v = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(v) ? v : null;
}

// Alpaca returns string "0" for filled_avg_price on orders that haven't
// produced a fill yet (e.g. status='accepted', filled_qty=0). Storing that as
// 0 in our broker_orders table would falsely look like "filled at $0", which
// is impossible. Distinguish: only treat the field as a real price when the
// broker has reported some filled quantity.
function avgFillFromAlpaca(o: AlpacaOrderResponse): number | null {
  const qty = n(o.filled_qty);
  if (qty <= 0) return null;
  return nMaybe(o.filled_avg_price);
}

function toSnapshot(o: AlpacaOrderResponse): BrokerOrderSnapshot {
  return {
    brokerOrderId: o.id,
    idempotencyKey: o.client_order_id ?? null,
    ticker: o.symbol,
    side: o.side,
    status: statusFromAlpaca(o.status),
    filledQuantity: n(o.filled_qty),
    avgFillPrice: avgFillFromAlpaca(o),
    submittedAt: o.submitted_at,
    filledAt: o.filled_at,
    canceledAt: o.canceled_at,
    raw: o
  };
}

export class AlpacaPaperBrokerClient implements BrokerClient {
  readonly name = 'alpaca_paper' as const;
  readonly isLiveCapable = true;
  private headers: Record<string, string>;

  constructor() {
    if (!env.alpacaApiKeyId || !env.alpacaApiSecretKey) {
      throw new Error('AlpacaPaperBrokerClient requires ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY');
    }
    if (!env.alpacaPaperBaseUrl.includes('paper')) {
      // Defense in depth: the base URL must be the paper endpoint. Anything
      // else is a misconfiguration that this codebase will not serve.
      throw new Error(`AlpacaPaperBrokerClient base URL must be a paper endpoint, got ${env.alpacaPaperBaseUrl}`);
    }
    this.headers = {
      'APCA-API-KEY-ID': env.alpacaApiKeyId,
      'APCA-API-SECRET-KEY': env.alpacaApiSecretKey,
      'Content-Type': 'application/json'
    };
  }

  private url(path: string): string {
    return `${env.alpacaPaperBaseUrl.replace(/\/$/, '')}${path}`;
  }

  async submitOrder(input: SubmitOrderInput): Promise<SubmitOrderResult> {
    const body: Record<string, unknown> = {
      symbol: input.ticker,
      qty: input.quantity,
      side: input.side,
      type: input.type === 'bracket' ? 'market' : input.type,
      time_in_force: input.timeInForce ?? 'day',
      client_order_id: input.idempotencyKey
    };
    if (input.limitPrice != null) body.limit_price = input.limitPrice;
    if (input.stopPrice != null) body.stop_price = input.stopPrice;
    if (input.type === 'bracket') {
      body.order_class = 'bracket';
      if (input.targetPrice == null || input.stopPrice == null) {
        throw new Error('Bracket orders require both targetPrice and stopPrice');
      }
      body.take_profit = { limit_price: input.targetPrice };
      body.stop_loss = { stop_price: input.stopPrice };
    }

    const res = await timedFetch(this.url('/v2/orders'), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      timeoutMs: env.fetchTimeoutMs
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`alpaca_submit_failed:${res.status}:${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as AlpacaOrderResponse;
    return {
      brokerOrderId: json.id,
      status: statusFromAlpaca(json.status),
      filledQuantity: n(json.filled_qty),
      avgFillPrice: avgFillFromAlpaca(json),
      raw: json
    };
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    const res = await timedFetch(this.url(`/v2/orders/${brokerOrderId}`), {
      method: 'DELETE',
      headers: this.headers,
      timeoutMs: env.fetchTimeoutMs
    });
    if (!res.ok && res.status !== 404 && res.status !== 422) {
      throw new Error(`alpaca_cancel_failed:${res.status}`);
    }
  }

  async cancelAllOrders(): Promise<{ canceledCount: number }> {
    const res = await timedFetch(this.url('/v2/orders'), {
      method: 'DELETE',
      headers: this.headers,
      timeoutMs: env.fetchTimeoutMs
    });
    if (!res.ok) {
      throw new Error(`alpaca_cancel_all_failed:${res.status}`);
    }
    const list = (await res.json().catch(() => [])) as Array<{ id: string }>;
    return { canceledCount: Array.isArray(list) ? list.length : 0 };
  }

  async getOrder(brokerOrderId: string): Promise<BrokerOrderSnapshot | null> {
    const res = await timedFetch(this.url(`/v2/orders/${brokerOrderId}`), {
      headers: this.headers,
      timeoutMs: env.fetchTimeoutMs
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`alpaca_get_order_failed:${res.status}`);
    const json = (await res.json()) as AlpacaOrderResponse;
    return toSnapshot(json);
  }

  async listOrdersSince(iso: string): Promise<BrokerOrderSnapshot[]> {
    // Alpaca caps a single /v2/orders response at 500 rows. To make
    // reconciliation safe even when activity spikes (paper accounts blast
    // hundreds of synthetic fills), page backwards using `until` set to the
    // earliest submitted_at we've seen, until either we exhaust results or hit
    // a hard safety cap.
    const PAGE_SIZE = 500;
    const MAX_PAGES = 20;
    const all: AlpacaOrderResponse[] = [];
    let until: string | null = null;
    for (let i = 0; i < MAX_PAGES; i += 1) {
      const url = new URL(this.url('/v2/orders'));
      url.searchParams.set('status', 'all');
      url.searchParams.set('after', iso);
      url.searchParams.set('direction', 'desc');
      url.searchParams.set('nested', 'true');
      url.searchParams.set('limit', String(PAGE_SIZE));
      if (until) url.searchParams.set('until', until);
      const res = await timedFetch(url.toString(), { headers: this.headers, timeoutMs: env.fetchTimeoutMs });
      if (!res.ok) throw new Error(`alpaca_list_orders_failed:${res.status}`);
      const list = (await res.json()) as AlpacaOrderResponse[];
      if (!Array.isArray(list) || list.length === 0) break;
      all.push(...list);
      if (list.length < PAGE_SIZE) break;
      // direction=desc → last item is oldest; use as paging cursor.
      const oldest = list[list.length - 1];
      if (!oldest?.submitted_at) break;
      // Avoid infinite loop if all rows share the same submitted_at: nudge
      // the cursor backwards by 1ms.
      const nextUntil = new Date(new Date(oldest.submitted_at).getTime() - 1).toISOString();
      if (nextUntil === until) break;
      until = nextUntil;
    }
    return all.map(toSnapshot);
  }

  async listPositions(): Promise<BrokerPositionSnapshot[]> {
    const res = await timedFetch(this.url('/v2/positions'), { headers: this.headers, timeoutMs: env.fetchTimeoutMs });
    if (!res.ok) throw new Error(`alpaca_list_positions_failed:${res.status}`);
    const list = (await res.json()) as AlpacaPositionResponse[];
    return Array.isArray(list)
      ? list.map((p) => ({
          ticker: p.symbol,
          quantity: n(p.qty),
          avgEntryPrice: nMaybe(p.avg_entry_price),
          marketValue: nMaybe(p.market_value),
          unrealizedPl: nMaybe(p.unrealized_pl),
          raw: p
        }))
      : [];
  }
}
