import { reconcileBrokerOrders, snapshotBrokerPositions, type ReconcileOrdersResult, type SnapshotPositionsResult } from '@/lib/broker/reconcile';
import { env } from '@/lib/env';
import { errorFields, logError } from '@/lib/log';
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

    // Reconcile and snapshot independently. A throw from reconcile must not
    // skip the position snapshot, and vice versa. Both stages already return
    // soft errors[] internally; this defends against the hard-throw cases
    // (network, auth, broker outage) where the caller previously bubbled.
    let orderRecon: ReconcileOrdersResult | null = null;
    let positionSnapshot: SnapshotPositionsResult | null = null;
    const flatErrors: Array<{ stage: string; message: string }> = [];

    try {
      orderRecon = await reconcileBrokerOrders(since);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError('broker_recon_threw', { stage: 'orders', ...errorFields(err) });
      flatErrors.push({ stage: 'recon:exception', message: msg });
    }

    try {
      positionSnapshot = await snapshotBrokerPositions();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError('broker_recon_threw', { stage: 'positions', ...errorFields(err) });
      flatErrors.push({ stage: 'position:exception', message: msg });
    }

    if (orderRecon) {
      flatErrors.push(...orderRecon.errors.map((e) => ({ stage: `recon:${e.idempotencyKey}`, message: e.message })));
    }
    if (positionSnapshot) {
      flatErrors.push(...positionSnapshot.errors.map((e) => ({ stage: `position:${e.ticker}`, message: e.message })));
    }

    // If either stage hard-failed OR reconcile reported inconclusive, the
    // overall run is inconclusive. The run-log machinery downgrades to
    // 'partial' status on inconclusive=true.
    const inconclusive = !orderRecon || !positionSnapshot || Boolean(orderRecon?.inconclusive);

    return {
      brokerMode: env.brokerMode,
      orderRecon,
      positionSnapshot,
      notes,
      errors: flatErrors,
      inconclusive
    };
  });
}
