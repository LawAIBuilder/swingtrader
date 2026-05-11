import { NextResponse } from 'next/server';
import { todayInNewYork } from '@/lib/utils/dates';

export async function GET() {
  return NextResponse.json({ ok: true, date: todayInNewYork() });
}
