import { getBotConfig } from "../../../../lib/omniflow/portal";
import { readSessionCookies } from "../../../../lib/omniflow/session-cookies";
import BotForm from "./BotForm";


export const dynamic = "force-dynamic";

export default async function MyBotPage() {
  const { accessToken } = await readSessionCookies();
  const config = accessToken ? await getBotConfig(accessToken) : null;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          AI agent
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Personality, greeting and handoff rules for the assistant that answers
          on your connected channels.
        </p>
      </div>

      <BotForm
        initial={config}
        backendConfigured={config?.configured ?? false}
      />
    </div>
  );
}
