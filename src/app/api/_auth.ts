import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';

// Constant-time string compare. Avoids leaking the secret's length and prefix
// match position over a network timing channel; in practice unlikely to be
// exploitable through Vercel's edge but free defence-in-depth.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Auth for cron-triggered job endpoints. Accepts either:
//  - Vercel Cron's default header: Authorization: Bearer <CRON_SECRET>
//  - The Express-era custom header: x-cron-secret: <CRON_SECRET>
//
// Default posture is FAIL CLOSED: if CRON_SECRET is unset in env, every
// authenticated route returns 401 unconditionally. The only escape hatch is
// the explicit ALLOW_UNAUTHENTICATED_CRON=true dev flag, which is intended
// for local docker-compose / npm run dev scenarios where you don't want to
// wire a secret through. In production, never set ALLOW_UNAUTHENTICATED_CRON.
//
// This default is the inverse of what Express did. The reasoning is that
// cron routes can write to the DB, place broker orders, and burn API
// budget. A fresh deploy that forgot CRON_SECRET should NOT be silently
// callable from the public internet.
export function isAuthorizedCron(req: NextRequest): boolean {
  if (!env.cronSecret) {
    return env.allowUnauthenticatedCron;
  }
  const auth = req.headers.get('authorization');
  if (auth) {
    const [scheme, value] = auth.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && value && safeEqual(value, env.cronSecret)) return true;
  }
  const headerSecret = req.headers.get('x-cron-secret');
  if (headerSecret && safeEqual(headerSecret, env.cronSecret)) return true;
  return false;
}

// Standard unauthorized response. Distinguishes the two deny reasons so
// operators reading deploy logs can spot a missing-secret config bug
// versus an actual bad-auth attempt.
export function unauthorizedResponse(): NextResponse {
  if (!env.cronSecret) {
    return NextResponse.json(
      {
        error: 'cron_secret_required',
        detail:
          'CRON_SECRET is not configured. Set it on Vercel/Railway env vars and redeploy. ' +
          'Use ALLOW_UNAUTHENTICATED_CRON=true only for local development.'
      },
      { status: 401 }
    );
  }
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
