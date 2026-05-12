// Broker adapter interface. Implementations:
//   - DisabledBrokerClient (default; refuses every operation)
//   - MockBrokerClient (in-memory, used in tests/dev)
//   - AlpacaPaperBrokerClient (network; only when BROKER_MODE=paper)
//
// There is NO live broker implementation in this codebase. Even a future
// Alpaca live adapter would require an explicit BROKER_MODE=live branch that
// does not exist here, plus passing the live execution gate.

export type BrokerName = 'alpaca_paper' | 'mock' | 'disabled';

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop' | 'bracket';
export type OrderStatus =
  | 'pending_submit'
  | 'submitted'
  | 'partially_filled'
  | 'filled'
  | 'canceled'
  | 'rejected'
  | 'expired'
  | 'submission_failed'
  | 'unknown';

export interface SubmitOrderInput {
  // Required. Stable identifier the application generates BEFORE submission so
  // the same logical order is never submitted twice. Used as the broker's
  // client_order_id where supported.
  idempotencyKey: string;
  ticker: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
  targetPrice?: number;
  // 'day' | 'gtc' | etc. The broker adapter is free to interpret.
  timeInForce?: string;
}

export interface SubmitOrderResult {
  brokerOrderId: string;
  status: OrderStatus;
  filledQuantity: number;
  avgFillPrice: number | null;
  raw?: unknown;
}

export interface BrokerOrderSnapshot {
  brokerOrderId: string;
  // The client-supplied idempotency key, echoed back from the broker.
  idempotencyKey: string | null;
  ticker: string;
  side: OrderSide;
  status: OrderStatus;
  filledQuantity: number;
  avgFillPrice: number | null;
  submittedAt?: string;
  filledAt?: string;
  canceledAt?: string;
  raw?: unknown;
}

export interface BrokerPositionSnapshot {
  ticker: string;
  quantity: number;
  avgEntryPrice: number | null;
  marketValue: number | null;
  unrealizedPl: number | null;
  raw?: unknown;
}

export interface BrokerClient {
  readonly name: BrokerName;
  // Returns true only when the adapter is wired up to actually call a broker.
  readonly isLiveCapable: boolean;
  submitOrder(input: SubmitOrderInput): Promise<SubmitOrderResult>;
  cancelOrder(brokerOrderId: string): Promise<void>;
  cancelAllOrders(): Promise<{ canceledCount: number }>;
  getOrder(brokerOrderId: string): Promise<BrokerOrderSnapshot | null>;
  listOrdersSince(iso: string): Promise<BrokerOrderSnapshot[]>;
  listPositions(): Promise<BrokerPositionSnapshot[]>;
}

// Sentinel error thrown when the operator attempts to call a broker
// operation but the broker mode is disabled. Surfaces to the API/CLI as a
// structured 409 rather than a 500 so the dashboard can show a clear
// "broker disabled" state.
export class BrokerDisabledError extends Error {
  readonly code = 'broker_disabled';
  constructor() {
    super('Broker mode is disabled. Set BROKER_MODE=paper to enable Alpaca paper.');
  }
}
