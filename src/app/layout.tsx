import './globals.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Nav } from '@/components/Nav';

export const metadata: Metadata = {
  title: 'Bounce Trader',
  description: 'Paper-only forward bounce-trade tracker'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900">
        <Nav />
        {children}
      </body>
    </html>
  );
}
