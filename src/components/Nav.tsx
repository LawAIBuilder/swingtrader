import Link from 'next/link';
import { Pill } from './Pill';
import { getCurrentUser, isAdminEmail } from '@/lib/supabase/server';
import { env, hasPublicSupabaseConfig } from '@/lib/env';

const links = [
  { href: '/', label: 'Dashboard' },
  { href: '/trades', label: 'Trades' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/runs', label: 'Runs' },
  { href: '/execution', label: 'Execution' },
  { href: '/settings', label: 'Settings' }
];

export async function Nav() {
  const user = hasPublicSupabaseConfig() && env.dashboardAuthRequired ? await getCurrentUser() : null;
  return (
    <nav className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
        <Link href="/" className="flex items-center gap-2 text-base font-semibold tracking-tight text-slate-900">
          <span>Bounce Trader</span>
          <Pill tone="paper" title="No live broker code is enabled in this build">PAPER</Pill>
        </Link>
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
          {links.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="rounded px-2 py-1 hover:bg-slate-100 hover:text-slate-900">
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="ml-auto flex items-center gap-2 text-xs text-slate-500">
          {user ? (
            <>
              <Pill tone={isAdminEmail(user.email) ? 'success' : 'warning'}>{user.email}</Pill>
              <Link className="text-sky-700 hover:underline" href="/auth/signout">sign out</Link>
            </>
          ) : env.dashboardAuthRequired ? (
            <Link className="text-sky-700 hover:underline" href="/login">sign in</Link>
          ) : (
            <Pill tone="warning" title="DASHBOARD_AUTH_REQUIRED=false">auth disabled</Pill>
          )}
        </div>
      </div>
    </nav>
  );
}
