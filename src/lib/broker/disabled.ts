import {
  BrokerDisabledError,
  type BrokerClient,
  type BrokerOrderSnapshot,
  type BrokerPositionSnapshot,
  type SubmitOrderInput,
  type SubmitOrderResult
} from './client';

// Default broker. Every operation throws BrokerDisabledError. Used when the
// operator has not opted into BROKER_MODE=paper, ensuring no order can ever
// reach a network call.
export class DisabledBrokerClient implements BrokerClient {
  readonly name = 'disabled' as const;
  readonly isLiveCapable = false;
  async submitOrder(_input: SubmitOrderInput): Promise<SubmitOrderResult> {
    throw new BrokerDisabledError();
  }
  async cancelOrder(_brokerOrderId: string): Promise<void> {
    throw new BrokerDisabledError();
  }
  async cancelAllOrders(): Promise<{ canceledCount: number }> {
    throw new BrokerDisabledError();
  }
  async getOrder(_brokerOrderId: string): Promise<BrokerOrderSnapshot | null> {
    throw new BrokerDisabledError();
  }
  async listOrdersSince(_iso: string): Promise<BrokerOrderSnapshot[]> {
    throw new BrokerDisabledError();
  }
  async listPositions(): Promise<BrokerPositionSnapshot[]> {
    throw new BrokerDisabledError();
  }
}
