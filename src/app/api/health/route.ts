import { NextResponse } from 'next/server';
import { env, hasPublicSupabaseConfig, hasSupabaseConfig } from '@/lib/env';
import { polygonBreaker } from '@/lib/market/polygon';
import { getSupabasePublic } from '@/lib/supabase/public';
import { todayInNewYork } from '@/lib/utils/dates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DbProbe {
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
}

// Cheap liveness probe: hit one of the public dashboard views with limit(1).
// We don't care about the row, just whether the round-trip completes within
// the timeout. The view is granted to the anon role, so a missing GRANT or
// schema-drift (e.g. anon lost SELECT after a migration) shows up here as
// `error` rather than a silent 200.
//
// Capped at 4s so a Supabase incident never makes /api/health time out and
// confuse uptime monitors into thinking the app itself is down.
async function probeSupabase(): Promise<DbProbe | null> {
  if (!hasPublicSupabaseConfig()) return null;
  const started = Date.now();
  try {
    const supabase = getSupabasePublic();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    try {
      const { error } = await supabase
        .from('v_recent_run_logs')
        .select('id', { head: true })
        .limit(1)
        .abortSignal(controller.signal);
      if (error) {
        return { ok: false, latencyMs: Date.now() - started, error: error.message.slice(0, 200) };
      }
      return { ok: true, latencyMs: Date.now() - started, error: null };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)
    };
  }
}

// Public health endpoint. Returns enough operational state to verify a deploy
// is alive AND configured the way you intended, without ever leaking a secret.
// We expose presence flags ("polygon configured") rather than the values
// themselves. Vercel injects VERCEL_GIT_COMMIT_SHA and VERCEL_ENV automatically
// at build time so /api/health doubles as a deploy fingerprint.
export async function GET() {
  const db = await probeSupabase();
  return NextResponse.json({
    ok: true,
    date: todayInNewYork(),
    timestamp: new Date().toISOString(),
    deploy: {
      env: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) ?? null,
      region: process.env.VERCEL_REGION ?? null
    },
    config: {
      tradingMode: env.tradingMode,
      brokerMode: env.brokerMode,
      marketProvider: env.marketDataProvider,
      mockMarketData: env.mockMarketData,
      useMockAi: env.useMockAi,
      freshnessMode: env.marketDataFreshnessMode,
      entryMode: env.entryMode,
      promptVersion: env.promptVersion,
      adminEmailsConfigured: env.adminEmails.length > 0,
      authRequired: env.dashboardAuthRequired,
      // True iff /api/jobs/* would accept an unauthenticated request right
      // now. This should ONLY be true in local dev. If a production health
      // probe shows true, rotate CRON_SECRET in and redeploy immediately.
      cronOpenToPublic: !env.cronSecret && env.allowUnauthenticatedCron
    },
    secrets: {
      // Presence-only — never the value.
      cronSecret: Boolean(env.cronSecret),
      supabaseAdmin: hasSupabaseConfig(),
      supabasePublic: hasPublicSupabaseConfig(),
      polygon: Boolean(env.polygonApiKey),
      anthropic: Boolean(env.anthropicApiKey),
      finnhub: Boolean(env.finnhubApiKey),
      alpacaPaper: Boolean(env.alpacaApiKeyId && env.alpacaApiSecretKey),
      resend: Boolean(env.resendApiKey)
    },
    // null when Supabase isn't configured at all; otherwise either {ok:true}
    // with measured latency or {ok:false, error} with the truncated supabase
    // error. A failing probe does NOT 500 this endpoint — uptime monitors
    // should still see HTTP 200 with `db.ok=false` and alert on that field.
    db,
    // Process-scoped circuit breaker around Polygon. Only meaningful within
    // a single function invocation but still useful in dev / dedicated
    // server deployments to confirm the breaker hasn't gotten stuck open
    // after a provider blip. `state` is one of closed|open|half_open.
    breakers: {
      polygon: polygonBreaker.snapshot()
    }
  });
}
