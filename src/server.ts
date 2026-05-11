import express from 'express';
import next from 'next';
import cron from 'node-cron';
import { env } from '@/lib/env';
import { runScreenerJob } from '@/jobs/screener';
import { runOutcomeTrackerJob } from '@/jobs/outcomes';
import { runDailySummaryJob } from '@/jobs/summary';
import { todayInNewYork } from '@/lib/utils/dates';

function verifyCronSecret(req: express.Request, res: express.Response, nextFn: express.NextFunction) {
  if (!env.cronSecret) return nextFn();
  const querySecret = typeof req.query.secret === 'string' ? req.query.secret : undefined;
  const supplied = req.header('x-cron-secret') ?? querySecret;
  if (supplied !== env.cronSecret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  nextFn();
}

async function main() {
  const dev = env.nodeEnv !== 'production';
  const nextApp = env.enableWeb ? next({ dev }) : null;
  const handle = nextApp ? nextApp.getRequestHandler() : null;
  if (nextApp) await nextApp.prepare();

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, date: todayInNewYork(), cron: env.enableCron, web: env.enableWeb });
  });

  app.post('/jobs/screener', verifyCronSecret, async (req, res) => {
    try {
      const result = await runScreenerJob(req.body?.runDate);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/jobs/outcomes', verifyCronSecret, async (req, res) => {
    try {
      const result = await runOutcomeTrackerJob(req.body?.runDate);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/jobs/summary', verifyCronSecret, async (req, res) => {
    try {
      const result = await runDailySummaryJob(req.body?.runDate);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  if (handle) {
    app.all('*', (req, res) => handle(req, res));
  } else {
    app.get('*', (_req, res) => res.json({ ok: true, mode: 'worker-only' }));
  }

  app.listen(env.port, () => {
    console.log(`Bounce Trader listening on port ${env.port}`);
    console.log(`Cron enabled: ${env.enableCron}; timezone: ${env.timezone}`);
  });

  if (env.enableCron) {
    // Screener runs at 4:15 PM ET, after the regular session close at 4:00 PM ET.
    // This is intentional: at 3:30 PM the day's daily-bar aggregate is not yet
    // settled, so the screener would silently use the prior business day's data.
    // If Polygon publishes late on a given day, runScreener throws
    // MarketDataNotSettledError and the job logs a skipped run (see screener.ts).
    cron.schedule('15 16 * * 1-5', () => {
      runScreenerJob().then((r) => console.log('screener done', r)).catch((e) => console.error('screener failed', e));
    }, { timezone: env.timezone });

    // Outcome tracker runs at 5:00 PM ET, giving the daily bar another ~45 minutes
    // to settle so per-ticker bar lookups for open and pending trades succeed.
    cron.schedule('0 17 * * 1-5', () => {
      runOutcomeTrackerJob().then((r) => console.log('outcomes done', r)).catch((e) => console.error('outcomes failed', e));
    }, { timezone: env.timezone });

    // Daily summary runs at 5:30 PM ET, after both upstream jobs have written
    // their run logs and any newly-closed trades.
    cron.schedule('30 17 * * 1-5', () => {
      runDailySummaryJob().then((r) => console.log('summary done', r)).catch((e) => console.error('summary failed', e));
    }, { timezone: env.timezone });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
