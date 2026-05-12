import { NextResponse } from 'next/server';
import { env, hasPublicSupabaseConfig, hasSupabaseConfig } from '@/lib/env';
import { todayInNewYork } from '@/lib/utils/dates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Public health endpoint. Returns enough operational state to verify a deploy
// is alive AND configured the way you intended, without ever leaking a secret.
// We expose presence flags ("polygon configured") rather than the values
// themselves. Vercel injects VERCEL_GIT_COMMIT_SHA and VERCEL_ENV automatically
// at build time so /api/health doubles as a deploy fingerprint.
export async function GET() {
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
      authRequired: env.dashboardAuthRequired
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
    }
  });
}
