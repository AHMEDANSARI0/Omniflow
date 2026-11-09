import { safeJson } from '../../../../../lib/omniflow/request-security';
import { sameSecret } from '../../../../../lib/omniflow/site-analytics';
import { collectRealAnalytics } from '../../../../lib/real-data-source';

export const runtime = 'nodejs';

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET ?? '';
  const given = request.headers.get('authorization') ?? '';
  return Boolean(secret && sameSecret(given, 'Bearer ' + secret));
}

export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return safeJson({ error: { code: 'unauthorized', message: 'Not allowed.' } }, 401);
  }
  try {
    const stats = await collectRealAnalytics(true);
    return safeJson({ status: 'ok', stats, collectedAt: stats.timestamp }, 200);
  } catch {
    return safeJson({ error: { code: 'collection_failed', message: 'Failed to collect analytics' } }, 500);
  }
}

export async function POST(request: Request): Promise<Response> {
  return GET(request);
}
