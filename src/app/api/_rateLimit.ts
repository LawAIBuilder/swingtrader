import type { NextRequest } from 'next/server';
import { env } from '@/lib/env';

// Best-effort in-memory rate limiter. A serverless deploy with multiple
// instances will let through up to N * instance-count requests per minute,
// but the goal here is just to stop a misconfigured cron loop or a
// brute-force probe from melting the AI budget. A real production deploy
// should swap this for Upstash/KV-backed accounting if needed.

interface Bucket {
  windowStart: number;
  count: number;
}

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;
// Cap on the bucket map to bound memory if a long-lived serverless instance
// sees thousands of unique IPs. We sweep stale entries lazily; if we're still
// over the cap after sweeping, we evict the oldest entries.
const MAX_BUCKETS = 2_000;
let lastSweepAt = 0;
const SWEEP_INTERVAL_MS = 30_000;

function clientKey(req: NextRequest): string {
  // Vercel forwards the real client IP via x-forwarded-for. Fall back to a
  // single shared bucket so misconfigured deployments are still rate-limited.
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get('x-real-ip');
  if (real) return real;
  return 'unknown';
}

function sweepIfNeeded(now: number): void {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS && buckets.size <= MAX_BUCKETS) return;
  lastSweepAt = now;
  for (const [k, b] of buckets) {
    if (now - b.windowStart > WINDOW_MS) buckets.delete(k);
  }
  if (buckets.size > MAX_BUCKETS) {
    // Keep only the most recently active half.
    const entries = Array.from(buckets.entries()).sort((a, b) => b[1].windowStart - a[1].windowStart);
    buckets.clear();
    for (const [k, b] of entries.slice(0, Math.floor(MAX_BUCKETS / 2))) {
      buckets.set(k, b);
    }
  }
}

export function rateLimitOk(req: NextRequest): boolean {
  const limit = env.jobRateLimitPerMinute;
  if (limit <= 0) return true;
  const key = clientKey(req);
  const now = Date.now();
  sweepIfNeeded(now);
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    buckets.set(key, { windowStart: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

// Manual reset for unit tests.
export function _resetRateLimitForTests(): void {
  buckets.clear();
}
