import { Card } from '@/components/Card';
import { Pill } from '@/components/Pill';
import { env, hasPublicSupabaseConfig, hasSupabaseConfig } from '@/lib/env';
import { getMarketDataProviderInfo } from '@/lib/market/provider';

export const dynamic = 'force-dynamic';

interface Setting {
  label: string;
  value: React.ReactNode;
  description?: string;
}

interface Section {
  title: string;
  description?: string;
  settings: Setting[];
}

function YesNo({ value }: { value: boolean }) {
  return <Pill tone={value ? 'success' : 'warning'}>{value ? 'configured' : 'missing'}</Pill>;
}

function Section({ section }: { section: Section }) {
  return (
    <Card title={section.title} subtitle={section.description}>
      <dl className="grid gap-3 sm:grid-cols-2">
        {section.settings.map((s) => (
          <div key={s.label} className="rounded-md bg-slate-50 px-3 py-2 ring-1 ring-slate-200">
            <dt className="text-[10px] uppercase tracking-wide text-slate-500">{s.label}</dt>
            <dd className="mt-0.5 text-sm font-medium text-slate-900">{s.value}</dd>
            {s.description ? <dd className="mt-1 text-[11px] text-slate-500">{s.description}</dd> : null}
          </div>
        ))}
      </dl>
    </Card>
  );
}

export default function SettingsPage() {
  const provider = getMarketDataProviderInfo();
  const sections: Section[] = [
    {
      title: 'Runtime',
      description: 'Read-only view of how the deployed app is configured. No secrets are shown.',
      settings: [
        { label: 'NODE_ENV', value: env.nodeEnv },
        { label: 'TZ', value: env.timezone },
        { label: 'APP_BASE_URL', value: env.appBaseUrl },
        { label: 'ENABLE_CRON (Express server only)', value: String(env.enableCron) },
        { label: 'ENABLE_WEB (Express server only)', value: String(env.enableWeb) },
        { label: 'CRON_SECRET', value: <YesNo value={Boolean(env.cronSecret)} /> }
      ]
    },
    {
      title: 'Market data',
      settings: [
        { label: 'Resolved provider', value: <Pill tone={provider.name === 'polygon' ? 'success' : 'warning'}>{provider.name}</Pill>, description: provider.reason },
        { label: 'MARKET_DATA_PROVIDER (env)', value: provider.configured },
        { label: 'POLYGON_BASE_URL', value: provider.baseUrl ?? 'n/a' },
        { label: 'POLYGON_API_KEY', value: <YesNo value={provider.apiKeyConfigured} /> },
        { label: 'MOCK_MARKET_DATA', value: String(env.mockMarketData) },
        { label: 'MARKET_DATA_FRESHNESS_MODE', value: env.marketDataFreshnessMode, description: 'Production should be same_day_required' },
        { label: 'MAX_CANDIDATES_PER_SCREEN', value: env.maxCandidatesPerScreen },
        { label: 'DETAILS_CONCURRENCY', value: env.detailsConcurrency },
        { label: 'GROUPED_BARS_CONCURRENCY', value: env.groupedBarsConcurrency }
      ]
    },
    {
      title: 'AI analyzer',
      settings: [
        { label: 'Resolved AI mode', value: <Pill tone={env.useMockAi || !env.anthropicApiKey ? 'warning' : 'success'}>{env.useMockAi || !env.anthropicApiKey ? 'mock' : 'anthropic'}</Pill> },
        { label: 'ANTHROPIC_MODEL', value: env.anthropicModel },
        { label: 'ANTHROPIC_API_KEY', value: <YesNo value={Boolean(env.anthropicApiKey)} /> },
        { label: 'PROMPT_VERSION', value: env.promptVersion },
        { label: 'USE_MOCK_AI', value: String(env.useMockAi) },
        { label: 'ANTHROPIC_TIMEOUT_MS', value: env.anthropicTimeoutMs },
        { label: 'ANTHROPIC_CONCURRENCY', value: env.anthropicConcurrency }
      ]
    },
    {
      title: 'Risk and screening',
      settings: [
        { label: 'ENTRY_MODE', value: env.entryMode, description: 'next_day_open is the executable series' },
        { label: 'TIME_STOP_DAYS', value: env.timeStopDays },
        { label: 'MIN_PRICE / MAX_PRICE', value: `$${env.minPrice} – $${env.maxPrice}` },
        { label: 'MIN_MARKET_CAP', value: `$${env.minMarketCap.toLocaleString()}` },
        { label: 'MIN_AVG_DOLLAR_VOLUME', value: `$${env.minAvgDollarVolume.toLocaleString()}` },
        { label: 'SCREEN_A drop / rel vol', value: `${env.screenADropPct}% / ≥${env.screenARelVolume}x` },
        { label: 'SCREEN_B 5d drop / 20d dd', value: `${env.screenB5dDropPct}% / ${env.screenBDrawdown20dPct}%` }
      ]
    },
    {
      title: 'Pre-flag data sources',
      settings: [
        { label: 'EARNINGS_CALENDAR_PROVIDER', value: env.earningsCalendarProvider },
        { label: 'FINNHUB_API_KEY', value: <YesNo value={Boolean(env.finnhubApiKey)} /> },
        { label: 'EDGAR_ENABLED', value: String(env.edgarEnabled) },
        { label: 'EDGAR_USER_AGENT', value: env.edgarUserAgent },
        { label: 'CORP_ACTION_LOOKBACK_DAYS', value: env.corpActionLookbackDays },
        { label: 'CORP_ACTION_LOOKAHEAD_DAYS', value: env.corpActionLookaheadDays },
        { label: 'OFFERING_LOOKBACK_DAYS', value: env.offeringLookbackDays }
      ]
    },
    {
      title: 'Run safety',
      settings: [
        { label: 'FETCH_TIMEOUT_MS', value: env.fetchTimeoutMs },
        { label: 'RUN_LOCK_TTL_MS', value: env.runLockTtlMs }
      ]
    },
    {
      title: 'Persistence',
      settings: [
        { label: 'Supabase admin (writes)', value: <YesNo value={hasSupabaseConfig()} /> },
        { label: 'Supabase public (reads)', value: <YesNo value={hasPublicSupabaseConfig()} /> }
      ]
    },
    {
      title: 'Email summary',
      settings: [
        { label: 'RESEND_API_KEY', value: <YesNo value={Boolean(env.resendApiKey)} /> },
        { label: 'EMAIL_FROM', value: env.emailFrom ?? '—' },
        { label: 'EMAIL_TO', value: env.emailTo ?? '—' }
      ]
    },
    {
      title: 'Intraday paper mode',
      description: 'Active only when TRADING_MODE includes intraday_paper. Live execution is unavailable regardless.',
      settings: [
        { label: 'TRADING_MODE', value: env.tradingMode.join(',') },
        { label: 'INTRADAY_PROVIDER', value: env.intradayProvider },
        { label: 'INTRADAY_MAX_SPREAD_BPS', value: env.intradayMaxSpreadBps },
        { label: 'INTRADAY_MAX_QUOTE_AGE_SECONDS', value: env.intradayMaxQuoteAgeSeconds, description: 'Quotes older than this are rejected for both progression ticks and entries.' },
        { label: 'INTRADAY_TIME_STOP_MINUTES', value: env.intradayTimeStopMinutes },
        { label: 'INTRADAY_RISK_PER_TRADE_PCT', value: env.intradayRiskPerTradePct }
      ]
    },
    {
      title: 'Broker (paper only)',
      description: 'There is no live broker mode in this codebase. BROKER_MODE=paper targets Alpaca paper API.',
      settings: [
        { label: 'BROKER_MODE', value: <Pill tone={env.brokerMode === 'paper' ? 'success' : 'neutral'}>{env.brokerMode}</Pill> },
        { label: 'ALPACA_PAPER_BASE_URL', value: env.alpacaPaperBaseUrl },
        { label: 'ALPACA_API_KEY_ID', value: <YesNo value={Boolean(env.alpacaApiKeyId)} /> },
        { label: 'ALPACA_API_SECRET_KEY', value: <YesNo value={Boolean(env.alpacaApiSecretKey)} /> }
      ]
    },
    {
      title: 'Live execution gate',
      description: 'Reports whether live orders would be allowed. The codepath that places live orders does not exist; this is an advisory gate.',
      settings: [
        { label: 'EXECUTION_GATE_MIN_SAMPLES', value: env.executionGate.minSamples },
        { label: 'EXECUTION_GATE_MIN_NET_PNL', value: env.executionGate.minNetPnl },
        { label: 'EXECUTION_GATE_MAX_DRAWDOWN', value: env.executionGate.maxDrawdown },
        { label: 'EXECUTION_GATE_MIN_RECON_DAYS', value: env.executionGate.minReconDays },
        { label: 'EXECUTION_GATE_MANUALLY_ENABLED', value: String(env.executionGate.manuallyEnabled) },
        { label: 'HALT_MAX_DAILY_LOSS_PCT', value: env.haltLimits.maxDailyLossPct },
        { label: 'HALT_MAX_CONCURRENT_POSITIONS', value: env.haltLimits.maxConcurrentPositions },
        { label: 'HALT_STALE_DATA_MAX_MINUTES', value: env.haltLimits.staleDataMaxMinutes }
      ]
    },
    {
      title: 'Auth & rate limiting',
      settings: [
        { label: 'DASHBOARD_AUTH_REQUIRED', value: String(env.dashboardAuthRequired) },
        { label: 'ADMIN_EMAILS configured', value: env.adminEmails.length },
        { label: 'JOB_RATE_LIMIT_PER_MINUTE', value: env.jobRateLimitPerMinute }
      ]
    }
  ];

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-slate-500">
          Read-only view of env-driven configuration. Change values in Vercel /
          Railway env vars, then redeploy. Secret <em>presence</em> is shown but
          never the values themselves.
        </p>
      </header>
      {sections.map((s) => <Section key={s.title} section={s} />)}
    </main>
  );
}
