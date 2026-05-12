import { Card } from '@/components/Card';
import { ClosedTradesList, OpenTradesList } from '@/components/CandidateRow';
import { EmptyState } from '@/components/EmptyState';
import { fetchDashboardData } from '@/lib/dashboard/data';

export const dynamic = 'force-dynamic';

export default async function TradesPage() {
  const data = await fetchDashboardData();
  if (!data) {
    return (
      <main className="mx-auto max-w-4xl p-6">
        <Card title="Setup needed">
          <p className="text-sm text-slate-700">Configure Supabase env vars before viewing trades.</p>
        </Card>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Trades</h1>
        <p className="mt-1 text-sm text-slate-500">All open and recently closed paper trades. Click a row for details.</p>
      </header>
      <Card title={`Open trades (${data.openTrades.length})`}>
        {data.openTrades.length === 0 ? (
          <EmptyState title="No open paper trades." />
        ) : (
          <OpenTradesList rows={data.openTrades} />
        )}
      </Card>
      <Card title={`Recent closed (${data.recentClosed.length})`} subtitle="Most recent 50">
        {data.recentClosed.length === 0 ? (
          <EmptyState title="No closed trades yet." />
        ) : (
          <ClosedTradesList rows={data.recentClosed} />
        )}
      </Card>
    </main>
  );
}
