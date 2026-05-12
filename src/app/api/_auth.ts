import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
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
// If CRON_SECRET is not configured, endpoints are open (matches the original
// Express server). Set CRON_SECRET on Vercel to lock them down, which is also
// what Vercel Cron uses to call protected routes.
export function isAuthorizedCron(req: NextRequest): boolean {
  if (!env.cronSecret) return true;
  const auth = req.headers.get('authorization');
  if (auth) {
    const [scheme, value] = auth.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && value && safeEqual(value, env.cronSecret)) return true;
  }
  const headerSecret = req.headers.get('x-cron-secret');
  if (headerSecret && safeEqual(headerSecret, env.cronSecret)) return true;
  return false;
}
