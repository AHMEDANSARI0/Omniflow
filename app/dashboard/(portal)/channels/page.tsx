import SocialConnectorsHub from "../../../components/portal/SocialConnectorsHub";

export default function PortalChannelsHubPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.2em] text-brand">
          Workspace Channels
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Social & Messaging Connectors
        </h1>
        <p className="mt-1.5 text-sm text-ink-2">
          Connect Instagram, Facebook Messenger, TikTok Business, LinkedIn Company Page, and WhatsApp Business to your AI workspace.
        </p>
      </div>
      <SocialConnectorsHub />
    </div>
  );
}
