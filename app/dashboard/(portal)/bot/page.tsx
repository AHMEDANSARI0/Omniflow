import { createClient } from "../../../../lib/supabase/server";
import BotForm, { type BotSettings } from "./BotForm";

const DEFAULT_BOT: BotSettings = {
  bot_name: "Assistant",
  is_active: true,
  welcome_message:
    "Hi! Thanks for reaching out. How can I help you today?",
  instructions: "",
  tone: "friendly",
  fallback_message:
    "I'm not sure about that — let me connect you with our team.",
};

export default async function MyBotPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data } = await supabase
    .from("bot_settings")
    .select("*")
    .eq("id", user!.id)
    .single();

  const settings: BotSettings = {
    ...DEFAULT_BOT,
    ...((data as Partial<BotSettings> | null) ?? {}),
  };

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          My Bot
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          Configure how your AI assistant greets and talks to customers.
        </p>
      </div>

      <BotForm settings={settings} />
    </div>
  );
}