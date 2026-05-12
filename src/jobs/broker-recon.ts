import { reconcileBrokerOrders, snapshotBrokerPositions, type ReconcileOrdersResult, type SnapshotPositionsResult } from '@/lib/broker/reconcile';
import { env } from '@/lib/env';
import { withRunLog } from '@/lib/run-log';

export interface BrokerReconJobResult {
  brokerMode: string;
  orderRecon: ReconcileOrdersResult | null;
  positionSnapshot: SnapshotPositionsResult | null;
  notes: string[];
  // Flat fields surfaced for run-log lifecycle: deriveTerminalStatus only
  // looks at the top level. Without these, an inconclusive recon or a
  // failing position fetch would land in run_logs as 'success'.
  errors: Array<{ stage: string; message: string }>;
  inconclusive?: boolean;
}

// Reconcile broker orders + snapshot positions. Idempotent on its own; runs
// fast even when there's nothing to do because the broker calls return
// quickly.
export async function runBrokerReconJob(options: { sinceIso?: string } = {}): Promise<BrokerReconJobResult> {
  return withRunLog('broker_recon', {}, async () => {
    const notes: string[] = [];
    if (env.brokerMode === 'disabled') {
      notes.push('broker_mode=disabled; nothing to reconcile.');
      return {
        brokerMode: env.brokerMode,
        orderRecon: null,
        positionSnapshot: null,
        notes,
        errors: []
      };
    }
    const since = options.sinceIso ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const orderRecon = await reconcileBrokerOrders(since);
    const positionSnapshot = await snapshotBrokerPositions();

    const flatErrors: Array<{ stage: string; message: string }> = [
      ...orderRecon.errors.map((e) => ({ stage: `recon:${e.idempotencyKey}`, message: e.message })),
      ...positionSnapshot.errors.map((e) => ({ stage: `position:${e.ticker}`, message: e.message }))
    ];
    return {
      brokerMode: env.brokerMode,
      orderRecon,
      positionSnapshot,
      notes,
      errors: flatErrors,
      inconclusive: orderRecon.inconclusive
    };
  });
}
