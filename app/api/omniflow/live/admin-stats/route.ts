import { NextResponse } from 'next/server';
import { collectRealAnalytics } from '../../../../lib/real-data-source';

export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  try {
    const stats = await collectRealAnalytics(false);
    return NextResponse.json(stats, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Failed to load stats' }, { status: 500 });
  }
}

export async function POST(): Promise<NextResponse> {
  try {
    const stats = await collectRealAnalytics(true);
    return NextResponse.json({ status: 'refreshed', stats }, { status: 200 });
  } catch {
    return NextResponse.json({ error: 'Failed to refresh stats' }, { status: 500 });
  }
}
