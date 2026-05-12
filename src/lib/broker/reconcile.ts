import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getBrokerClient } from './provider';
import type { BrokerOrderSnapshot, OrderStatus } from './client';

export interface ReconcileOrdersResult {
  ordersChecked: number;
  matched: number;
  mismatch: number;
  brokerUnknown: number;
  orphanLocal: number;
  retriedSubmissions: number;
  // True when reconcile decided not to draw conclusions because the broker
  // call failed or returned no data while we still have local rows. Without
  // this guard a transient outage would re-classify every order as orphan.
  inconclusive?: boolean;
  errors: Array<{ idempotencyKey: string; message: string }>;
}

interface BrokerOrderRow {
  id: number;
  idempotency_key: string;
  broker: string;
  broker_order_id: string | null;
  ticker: string;
  status: OrderStatus;
  filled_quantity: number;
  avg_fill_price: number | null;
}

function statusesAgreeOnFinality(local: OrderStatus, remote: OrderStatus): boolean {
  const terminal = new Set<OrderStatus>(['filled', 'canceled', 'rejected', 'expired']);
  return terminal.has(local) && terminal.has(remote) && local === remote;
}

function matchSnapshot(local: BrokerOrderRow, remote: BrokerOrderSnapshot): 'matched' | 'mismatch' {
  if (local.status === remote.status && Number(local.filled_quantity) === remote.filledQuantity) {
    return 'matched';
  }
  if (statusesAgreeOnFinality(local.status, remote.status)) return 'matched';
  return 'mismatch';
}

// Non-terminal local statuses that always need reconciliation regardless of
// when the row was created. A 'submitted' order from 7 days ago that just
// filled today must still be picked up; selecting only by `created_at` would
// silently miss it.
const NON_TERMINAL_LOCAL: OrderStatus[] = [
  'pending_submit',
  'submitted',
  'partially_filled',
  'submission_failed',
  'unknown'
];

// Per-call cap on point-lookup fallback queries to the broker. If we somehow
// have hundreds of stale local rows, we'd rather mark the rest as
// inconclusive than make hundreds of HTTP calls to the broker. In practice
// this should hardly ever fire because the bulk listOrdersSince is the
// primary path.
const MAX_FALLBACK_LOOKUPS = 50;

// Reconciliation: pull every broker order updated since `sinceIso` and
// compare against our local broker_orders table. Updates are minimal —
// we never *retry* a filled order, only update local records to reflect
// the broker's truth.
//
// Coverage strategy: the local SELECT pulls (a) every non-terminal row, no
// matter how old, plus (b) every row created in the window. Without (a),
// orders submitted before the window but updated/filled in it would be
// silently missed and stuck in `submitted` forever.
//
// Special cases:
//  * status='submission_failed' on our side AND no broker_order_id: try to
//    find a matching broker order by client_order_id. If we find one, our
//    submit must have actually reached the broker and we lost the response;
//    heal by writing the broker_order_id back. (Counts as retried_submission.)
//  * Local row has a broker_order_id but didn't appear in the bulk listing:
//    fall back to broker.getOrder(broker_order_id) before declaring it
//    broker_unknown. Bulk listings paginate by submitted_at; older orders
//    that recently changed may not surface.
//  * Local row exists but broker has nothing matching after the fallback:
//    'orphan_local'. The operator must investigate.
export async function reconcileBrokerOrders(sinceIso: string): Promise<ReconcileOrdersResult> {
  const supabase = getSupabaseAdmin();
  const broker = getBrokerClient();

  const result: ReconcileOrdersResult = {
    ordersChecked: 0,
    matched: 0,
    mismatch: 0,
    brokerUnknown: 0,
    orphanLocal: 0,
    retriedSubmissions: 0,
    errors: []
  };

  let remote: BrokerOrderSnapshot[];
  let remoteFailed = false;
  try {
    remote = await broker.listOrdersSince(sinceIso);
  } catch (err) {
    result.errors.push({ idempotencyKey: '*', message: err instanceof Error ? err.message : String(err) });
    remote = [];
    remoteFailed = true;
  }
  const remoteByKey = new Map<string, BrokerOrderSnapshot>();
  const remoteById = new Map<string, BrokerOrderSnapshot>();
  for (const o of remote) {
    if (o.idempotencyKey) remoteByKey.set(o.idempotencyKey, o);
    remoteById.set(o.brokerOrderId, o);
  }

  // Local query: every non-terminal row OR rows created in the window. The
  // OR-of-eqs syntax avoids duplicates because each row is selected once.
  const orFilter = [
    `created_at.gte.${sinceIso}`,
    ...NON_TERMINAL_LOCAL.map((s) => `status.eq.${s}`)
  ].join(',');
  const { data: localRows, error: localErr } = await supabase
    .from('broker_orders')
    .select('id,idempotency_key,broker,broker_order_id,ticker,status,filled_quantity,avg_fill_price')
    .or(orFilter);
  if (localErr) {
    result.errors.push({ idempotencyKey: '*', message: `local_select:${localErr.message}` });
    return result;
  }

  const locals = (localRows ?? []) as unknown as BrokerOrderRow[];
  result.ordersChecked = locals.length;

  // Inconclusive guard: if the broker call failed OR returned an empty list
  // while we still have local rows that the broker should have observed,
  // refuse to draw conclusions. Without this, a transient broker outage would
  // mark every local row as 'orphan_local' on the next pass — exactly the
  // signal the execution gate watches for halts.
  if ((remoteFailed || remote.length === 0) && locals.length > 0) {
    result.inconclusive = true;
    return result;
  }

  let fallbackLookups = 0;
  for (const local of locals) {
    try {
      let snapshot: BrokerOrderSnapshot | undefined;
      if (local.broker_order_id) snapshot = remoteById.get(local.broker_order_id);
      if (!snapshot) snapshot = remoteByKey.get(local.idempotency_key);

      // Fallback: if local has a broker_order_id but it isn't in the bulk
      // listing window, do a point lookup before declaring it unknown. The
      // bulk listing paginates by submitted_at, so an order submitted long
      // before sinceIso won't surface even if it was updated in the window.
      if (!snapshot && local.broker_order_id && fallbackLookups < MAX_FALLBACK_LOOKUPS) {
        try {
          fallbackLookups += 1;
          const direct = await broker.getOrder(local.broker_order_id);
          if (direct) snapshot = direct;
        } catch (err) {
          // Don't fail the whole row on a single transient point-lookup
          // miss. Falls through to the no-snapshot branch below.
          result.errors.push({
            idempotencyKey: local.idempotency_key,
            message: `getOrder_fallback:${err instanceof Error ? err.message : String(err)}`
          });
        }
      }

      if (!snapshot) {
        if (local.status === 'submission_failed' || !local.broker_order_id) {
          result.orphanLocal += 1;
          await supabase
            .from('broker_orders')
            .update({
              reconciliation_status: 'orphan_local',
              reconciled_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq('id', local.id);
          continue;
        }
        result.brokerUnknown += 1;
        await supabase
          .from('broker_orders')
          .update({
            reconciliation_status: 'broker_unknown',
            reconciled_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('id', local.id);
        continue;
      }

      const verdict = matchSnapshot(local, snapshot);
      const update: Record<string, unknown> = {
        broker_order_id: snapshot.brokerOrderId,
        status: snapshot.status,
        filled_quantity: snapshot.filledQuantity,
        avg_fill_price: snapshot.avgFillPrice,
        reconciliation_status: verdict,
        reconciled_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      if (snapshot.submittedAt) update.submitted_at = snapshot.submittedAt;
      if (snapshot.filledAt) update.filled_at = snapshot.filledAt;
      if (snapshot.canceledAt) update.canceled_at = snapshot.canceledAt;

      if (local.status === 'submission_failed' && snapshot.status !== 'rejected') {
        result.retriedSubmissions += 1;
        update.last_error = null;
      }

      await supabase.from('broker_orders').update(update).eq('id', local.id);
      if (verdict === 'matched') result.matched += 1;
      else result.mismatch += 1;
    } catch (err) {
      result.errors.push({
        idempotencyKey: local.idempotency_key,
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return result;
}

export interface SnapshotPositionsResult {
  positions: number;
  errors: Array<{ ticker: string; message: string }>;
}

// Take a point-in-time snapshot of broker positions to broker_positions.
export async function snapshotBrokerPositions(): Promise<SnapshotPositionsResult> {
  const supabase = getSupabaseAdmin();
  const broker = getBrokerClient();
  const result: SnapshotPositionsResult = { positions: 0, errors: [] };

  let positions;
  try {
    positions = await broker.listPositions();
  } catch (err) {
    result.errors.push({ ticker: '*', message: err instanceof Error ? err.message : String(err) });
    return result;
  }

  const observedAt = new Date().toISOString();
  const snapshotId = `snap-${observedAt}`;
  for (const p of positions) {
    try {
      const { error } = await supabase.from('broker_positions').insert({
        broker: broker.name === 'alpaca_paper' ? 'alpaca_paper' : 'mock',
        ticker: p.ticker,
        quantity: p.quantity,
        avg_entry_price: p.avgEntryPrice,
        market_value: p.marketValue,
        unrealized_pl: p.unrealizedPl,
        observed_at: observedAt,
        snapshot_id: snapshotId
      });
      if (error) throw error;
      result.positions += 1;
    } catch (err) {
      result.errors.push({ ticker: p.ticker, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
