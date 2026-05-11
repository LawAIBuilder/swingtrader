import express from 'express';
import next from 'next';
import cron from 'node-cron';
import { env } from '@/lib/env';
import { runScreenerJob } from '@/jobs/screener';
import { runOutcomeTrackerJob } from '@/jobs/outcomes';
import { runDailySummaryJob } from '@/jobs/summary';
import { JobLockedError } from '@/lib/run-log';
import { todayInNewYork } from '@/lib/utils/dates';

function verifyCronSecret(req: express.Request, res: express.Response, nextFn: express.NextFunction) {
  if (!env.cronSecret) return nextFn();
  const querySecret = typeof req.query.secret === 'string' ? req.query.secret : undefined;
  const auth = req.header('authorization');
  let bearer: string | undefined;
  if (auth) {
    const [scheme, value] = auth.split(' ');
    if (scheme?.toLowerCase() === 'bearer') bearer = value;
  }
  const supplied = bearer ?? req.header('x-cron-secret') ?? querySecret;
  if (supplied !== env.cronSecret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  nextFn();
}

interface JobInvocation {
  runDate?: string;
  force?: boolean;
}

function readInvocation(req: express.Request): JobInvocation {
  const body = (req.body ?? {}) as { runDate?: unknown; force?: unknown };
  const queryForce = req.query.force;
  const runDate = typeof body.runDate === 'string' ? body.runDate : undefined;
  const force = body.force === true || queryForce === '1' || queryForce === 'true';
  return { runDate, force };
}

function sendJobError(res: express.Response, jobName: string, runDate: string | undefined, err: unknown) {
  if (err instanceof JobLockedError) {
    res.status(409).json({
      skipped: true,
      reason: err.reason,
      jobName: err.jobName,
      runDate: err.runDate
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({
    event: 'job_route_failure',
    job: jobName,
    runDate: runDate ?? null,
    error: message
  }));
  res.status(500).json({ error: message });
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
    const invocation = readInvocation(req);
    try {
      const result = await runScreenerJob(invocation);
      res.json(result);
    } catch (err) {
      sendJobError(res, 'screener', invocation.runDate, err);
    }
  });

  app.post('/jobs/outcomes', verifyCronSecret, async (req, res) => {
    const invocation = readInvocation(req);
    try {
      const result = await runOutcomeTrackerJob(invocation);
      res.json(result);
    } catch (err) {
      sendJobError(res, 'outcome_tracker', invocation.runDate, err);
    }
  });

  app.post('/jobs/summary', verifyCronSecret, async (req, res) => {
    const invocation = readInvocation(req);
    try {
      const result = await runDailySummaryJob(invocation);
      res.json(result);
    } catch (err) {
      sendJobError(res, 'daily_summary', invocation.runDate, err);
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
    // Screener runs after the regular session close. The exact UTC offset is
    // whatever the configured timezone resolves to (DST-aware via node-cron).
    // Vercel Cron, by contrast, runs the same routes at fixed UTC times; see
    // vercel.json for that path.
    cron.schedule('15 16 * * 1-5', () => {
      runScreenerJob().then((r) => console.log('screener done', r)).catch((e) => {
        if (e instanceof JobLockedError) {
          console.log('screener skipped', { reason: e.reason });
        } else {
          console.error('screener failed', e);
        }
      });
    }, { timezone: env.timezone });

    cron.schedule('0 17 * * 1-5', () => {
      runOutcomeTrackerJob().then((r) => console.log('outcomes done', r)).catch((e) => {
        if (e instanceof JobLockedError) {
          console.log('outcomes skipped', { reason: e.reason });
        } else {
          console.error('outcomes failed', e);
        }
      });
    }, { timezone: env.timezone });

    cron.schedule('30 17 * * 1-5', () => {
      runDailySummaryJob().then((r) => console.log('summary done', r)).catch((e) => {
        if (e instanceof JobLockedError) {
          console.log('summary skipped', { reason: e.reason });
        } else {
          console.error('summary failed', e);
        }
      });
    }, { timezone: env.timezone });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
