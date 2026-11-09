import { NextResponse } from 'next/server';
import { sameSecret } from '../../../../../lib/omniflow/site-analytics';
import { handleDailyEmailCron } from '../../../../lib/email-reports';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET ?? '';
  const given = request.headers.get('authorization') ?? '';
  if (secret && !sameSecret(given, 'Bearer ' + secret)) {
    return NextResponse.json({ error: { code: 'unauthorized' } }, { status: 401 });
  }
  const type = new URL(request.url).searchParams.get('type') === 'weekly' ? 'weekly' : 'daily';
  const result = await handleDailyEmailCron(type);
  return NextResponse.json(result, { status: 200 });
}

export async function POST(request: Request): Promise<NextResponse> {
  const type = new URL(request.url).searchParams.get('type') === 'weekly' ? 'weekly' : 'daily';
  const result = await handleDailyEmailCron(type);
  return NextResponse.json(result, { status: 200 });
}
