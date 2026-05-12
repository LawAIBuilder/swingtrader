import { Card } from '@/components/Card';
import { EmptyState } from '@/components/EmptyState';
import { RunLogTable } from '@/components/RunLogTable';
import { fetchDashboardData } from '@/lib/dashboard/data';

export const dynamic = 'force-dynamic';

export default async function RunsPage() {
  const data = await fetchDashboardData();
  if (!data) {
    return (
      <main className="mx-auto max-w-4xl p-6">
        <Card title="Setup needed">
          <p className="text-sm text-slate-700">Configure Supabase env vars before viewing runs.</p>
        </Card>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Job runs</h1>
        <p className="mt-1 text-sm text-slate-500">Last 50 cron / manual job invocations. Expand a row for the full run_logs.details payload.</p>
      </header>
      <Card title={`Recent runs (${data.runLogs.length})`}>
        {data.runLogs.length === 0 ? (
          <EmptyState title="No job runs recorded yet." description="Trigger /api/jobs/screener manually or wait for the cron schedule." />
        ) : (
          <RunLogTable rows={data.runLogs} />
        )}
      </Card>
    </main>
  );
}
