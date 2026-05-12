import { NextResponse, type NextRequest } from 'next/server';
import { isAuthorizedCron } from '@/app/api/_auth';
import { rateLimitOk } from '@/app/api/_rateLimit';
import { getBrokerClient } from '@/lib/broker/provider';
import { env } from '@/lib/env';
import { writeRunLog } from '@/lib/run-log';

// Emergency cancel-all. Only valid when BROKER_MODE=paper. Rejects when
// disabled rather than silently no-op so the operator gets a clear signal.
// This route is intentionally NOT mounted on a Vercel cron schedule. It is
// meant for explicit manual or alerting-driven invocations only.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(req: NextRequest) {
  if (!rateLimitOk(req)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }
  // Defense in depth for a destructive endpoint: even when CRON_SECRET is
  // unset (which makes the read-only job endpoints open for local dev),
  // cancel-all is never callable without an explicit secret. Without this
  // a fresh deploy with BROKER_MODE=paper but no CRON_SECRET could let a
  // public actor wipe every paper order with one HTTP call.
  if (!env.cronSecret) {
    return NextResponse.json(
      { error: 'cron_secret_required', detail: 'Set CRON_SECRET before enabling broker cancel-all.' },
      { status: 401 }
    );
  }
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (env.brokerMode === 'disabled') {
    return NextResponse.json(
      { error: 'broker_disabled', detail: 'Set BROKER_MODE=paper to enable.' },
      { status: 409 }
    );
  }
  try {
    const broker = getBrokerClient();
    const result = await broker.cancelAllOrders();
    await writeRunLog({
      jobName: 'broker_cancel_all',
      status: 'success',
      details: { canceledCount: result.canceledCount, broker: broker.name }
    });
    return NextResponse.json({ ok: true, ...result, broker: broker.name });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeRunLog({
      jobName: 'broker_cancel_all',
      status: 'failed',
      details: { error: message }
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const POST = handle;
