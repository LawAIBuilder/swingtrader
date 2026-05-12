import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getBrokerClient } from './provider';
import type { OrderStatus, SubmitOrderInput } from './client';

export interface SubmitArgs {
  // Either paper_trade_id or intraday_trade_id should be set so the broker
  // order is linkable back to the originating internal trade. Both null is
  // allowed for ad-hoc operator orders.
  paperTradeId?: number | null;
  intradayTradeId?: number | null;
  order: SubmitOrderInput;
  notes?: string;
}

export interface SubmitOutcome {
  ok: boolean;
  brokerOrderRowId: number;
  brokerOrderId: string | null;
  status: OrderStatus;
  reused: boolean;
  error: string | null;
}

interface ExistingRow {
  id: number;
  status: OrderStatus;
  broker_order_id: string | null;
  filled_quantity: number;
  avg_fill_price: number | null;
  reconciliation_status: string;
}

// Idempotent submit. Algorithm:
//   1. Look up broker_orders by idempotency_key. If a row exists, do not
//      re-submit; return its current state.
//   2. Otherwise INSERT a 'pending_submit' row, then call broker.submitOrder.
//   3. On success, UPDATE the row with status/broker_order_id/fills.
//   4. On failure, UPDATE status='submission_failed' with the error message
//      so the next reconciliation pass can decide whether to retry.
//
// This sequence guarantees that a network/timeout between submit and DB
// write cannot create a duplicate broker order on retry: the broker enforces
// uniqueness on client_order_id, and our DB has UNIQUE(idempotency_key).
export async function submitOrderIdempotent(args: SubmitArgs): Promise<SubmitOutcome> {
  const supabase = getSupabaseAdmin();
  const broker = getBrokerClient();

  const { data: existing, error: existingErr } = await supabase
    .from('broker_orders')
    .select('id,status,broker_order_id,filled_quantity,avg_fill_price,reconciliation_status')
    .eq('idempotency_key', args.order.idempotencyKey)
    .maybeSingle();
  if (existingErr) {
    return {
      ok: false,
      brokerOrderRowId: -1,
      brokerOrderId: null,
      status: 'unknown',
      reused: false,
      error: `lookup_failed:${existingErr.message}`
    };
  }
  if (existing) {
    const row = existing as unknown as ExistingRow;
    return {
      ok: row.status !== 'submission_failed',
      brokerOrderRowId: row.id,
      brokerOrderId: row.broker_order_id,
      status: row.status,
      reused: true,
      error: null
    };
  }

  const { data: insertRow, error: insertErr } = await supabase
    .from('broker_orders')
    .insert({
      idempotency_key: args.order.idempotencyKey,
      paper_trade_id: args.paperTradeId ?? null,
      intraday_trade_id: args.intradayTradeId ?? null,
      broker: broker.name === 'alpaca_paper' ? 'alpaca_paper' : 'mock',
      ticker: args.order.ticker,
      side: args.order.side,
      order_type: args.order.type,
      quantity: args.order.quantity,
      limit_price: args.order.limitPrice ?? null,
      stop_price: args.order.stopPrice ?? null,
      target_price: args.order.targetPrice ?? null,
      time_in_force: args.order.timeInForce ?? null,
      status: 'pending_submit',
      payload: { notes: args.notes ?? null }
    })
    .select('id')
    .single();
  if (insertErr || !insertRow) {
    // Race recovery: if a sibling caller inserted with the same
    // idempotency_key between our SELECT and INSERT, the UNIQUE constraint
    // fires (Postgres 23505). Fall back to looking up the now-existing row
    // and returning its current state, exactly like the SELECT branch above.
    if ((insertErr as { code?: string } | null)?.code === '23505') {
      const { data: raced, error: racedErr } = await supabase
        .from('broker_orders')
        .select('id,status,broker_order_id,filled_quantity,avg_fill_price,reconciliation_status')
        .eq('idempotency_key', args.order.idempotencyKey)
        .maybeSingle();
      if (!racedErr && raced) {
        const row = raced as unknown as ExistingRow;
        return {
          ok: row.status !== 'submission_failed',
          brokerOrderRowId: row.id,
          brokerOrderId: row.broker_order_id,
          status: row.status,
          reused: true,
          error: null
        };
      }
    }
    return {
      ok: false,
      brokerOrderRowId: -1,
      brokerOrderId: null,
      status: 'unknown',
      reused: false,
      error: `insert_failed:${insertErr?.message ?? 'unknown'}`
    };
  }
  const rowId = (insertRow as unknown as { id: number }).id;

  try {
    const result = await broker.submitOrder(args.order);
    await supabase
      .from('broker_orders')
      .update({
        status: result.status,
        broker_order_id: result.brokerOrderId,
        filled_quantity: result.filledQuantity,
        avg_fill_price: result.avgFillPrice,
        submitted_at: new Date().toISOString(),
        filled_at: result.status === 'filled' ? new Date().toISOString() : null,
        updated_at: new Date().toISOString()
      })
      .eq('id', rowId);
    return {
      ok: true,
      brokerOrderRowId: rowId,
      brokerOrderId: result.brokerOrderId,
      status: result.status,
      reused: false,
      error: null
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase
      .from('broker_orders')
      .update({
        status: 'submission_failed',
        last_error: message,
        updated_at: new Date().toISOString()
      })
      .eq('id', rowId);
    return {
      ok: false,
      brokerOrderRowId: rowId,
      brokerOrderId: null,
      status: 'submission_failed',
      reused: false,
      error: message
    };
  }
}
