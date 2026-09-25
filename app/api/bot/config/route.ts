import { NextResponse } from "next/server";
import { authenticateApiKey } from "../../../../lib/bot-api";
import { createServiceClient } from "../../../../lib/supabase/service";

/**
 * GET /api/bot/config
 * Auth: Authorization: Bearer ofk_...
 * Returns the client's bot settings + business profile.
 * Any external bot (Python, Node, n8n, ...) reads its config from here.
 */
export async function GET(request: Request) {
  const userId = await authenticateApiKey(request);
  if (!userId) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
  }

  const supabase = createServiceClient();

  const [botResult, businessResult] = await Promise.all([
    supabase.from("bot_settings").select("*").eq("id", userId).single(),
    supabase.from("business_profiles").select("*").eq("id", userId).single(),
  ]);

  const bot = botResult.data ?? null;
  const business = businessResult.data ?? null;

  return NextResponse.json({
    bot: bot
      ? {
          name: bot.bot_name,
          is_active: bot.is_active,
          welcome_message: bot.welcome_message,
          instructions: bot.instructions,
          tone: bot.tone,
          fallback_message: bot.fallback_message,
        }
      : null,
    business: business
      ? {
          name: business.business_name,
          industry: business.industry,
          phone: business.phone,
          website: business.website,
          address: business.address,
          timezone: business.timezone,
          business_hours: business.business_hours,
          default_language: business.default_language,
        }
      : null,
  });
}