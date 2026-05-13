import { NextResponse, type NextRequest } from 'next/server';
import { isAuthorizedCron, unauthorizedResponse } from '@/app/api/_auth';
import { rateLimitOk } from '@/app/api/_rateLimit';
import { getBrokerClient } from '@/lib/broker/provider';
import { env } from '@/lib/env';
import { writeRunLog } from '@/lib/run-log';

// Emergency cancel-all. Only valid when BROKER_MODE=paper. Rejects when
// disabled rather than silently no-op so the operator gets a clear signal.
// This route is intentionally NOT mounted on a Vercel cron schedule. It is
// meant for explicit manual or alerting-driven invocations only.
//
// As of the fail-closed sweep, this route inherits the same default as the
// /api/jobs/* family: a missing CRON_SECRET is a 401, regardless of the
// ALLOW_UNAUTHENTICATED_CRON dev flag, because cancel-all is destructive
// even in dev.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(req: NextRequest) {
  if (!rateLimitOk(req)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }
  // Destructive endpoint: never trust ALLOW_UNAUTHENTICATED_CRON here.
  // Even local dev should set CRON_SECRET before enabling broker cancel-all,
  // and a forgotten secret in any environment must fail closed.
  if (!env.cronSecret) {
    return NextResponse.json(
      {
        error: 'cron_secret_required',
        detail:
          'Set CRON_SECRET before enabling broker cancel-all. ' +
          'ALLOW_UNAUTHENTICATED_CRON does not apply to destructive endpoints.'
      },
      { status: 401 }
    );
  }
  if (!isAuthorizedCron(req)) {
    return unauthorizedResponse();
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
