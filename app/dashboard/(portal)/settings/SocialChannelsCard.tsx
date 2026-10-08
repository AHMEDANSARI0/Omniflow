"use client";

/**
 * §255 social channels: TikTok, X, LinkedIn, YouTube and a personal Telegram account.
 * API mode = the merchant's own developer app + OAuth; login mode = the laptop bridge.
 */
import { useCallback, useEffect, useState } from "react";
import type {
  SocialChannelAccount,
  SocialChannelId,
  SocialChannelInput,
  SocialChannelsState,
  SocialFeature,
  SocialMode,
} from "../../../../lib/omniflow/portal";

const API = "/api/omniflow/portal/channels/social";
const INPUT =
  "w-full rounded-lg border border-line bg-soft px-2.5 py-1.5 text-xs text-ink outline-none focus:border-brand/40 disabled:opacity-60";
const BUTTON = "rounded-lg border border-line bg-soft px-2.5 py-1 text-[11px] text-ink-2 hover:text-ink disabled:opacity-60";
const FEATURE_LABELS: Record<SocialFeature, string> = {
  dm: "Direct messages",
  comments: "Comment replies",
  publish: "Publishing",
};
const POST_STATUS: Record<string, string> = {
  pending_approval: "Waiting for approval",
  queued: "Queued",
  published: "Published",
  failed: "Failed",
  rejected: "Rejected",
};

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  return (await response.json().catch(() => null)) as Record<string, unknown> | null;
}

function errorText(payload: Record<string, unknown> | null, fallback: string): string {
  const error = payload?.error as { message?: unknown } | undefined;
  return typeof error?.message === "string" && error.message ? error.message : fallback;
}

function when(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

interface KeyDraft {
  app_id: string;
  app_secret: string;
  consumer_secret: string;
  bearer_token: string;
  organization_id: string;
}

function draftOf(account: SocialChannelAccount): KeyDraft {
  return { app_id: account.app_id, app_secret: "", consumer_secret: "", bearer_token: "", organization_id: account.organization_id };
}

// GET the card state; a string is the message to show instead (no state set here)
async function fetchState(): Promise<SocialChannelsState | string> {
  try {
    const response = await fetch(API, { credentials: "same-origin", cache: "no-store" });
    const payload = await readJson(response);
    if (response.ok && payload && Array.isArray(payload.channels)) return payload as unknown as SocialChannelsState;
    return errorText(payload, "Could not load the social channels right now.");
  } catch {
    return "Could not load the social channels right now.";
  }
}

export default function SocialChannelsCard() {
  const [state, setState] = useState<SocialChannelsState | null>(null);
  const [selected, setSelected] = useState<SocialChannelId>("tiktok");
  const [draft, setDraft] = useState<KeyDraft | null>(null);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [postChannel, setPostChannel] = useState<SocialChannelId | "">("");
  const [postText, setPostText] = useState("");
  const [postMedia, setPostMedia] = useState("");

  const apply = useCallback((next: SocialChannelsState | string) => {
    if (typeof next === "string") setNote(next);
    else setState(next);
    setLoaded(true);
  }, []);
  const load = useCallback(() => fetchState().then(apply), [apply]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const back = params.get("social");
    const result = params.get("result");
    void fetchState().then((next) => {
      apply(next);
      if (!result) return;
      if (back && ["tiktok", "x", "linkedin", "youtube", "telegram_user"].includes(back)) setSelected(back as SocialChannelId);
      setNote(result === "ok" ? "Account connected." : "The account was not connected - check the app keys and try again.");
    });
  }, [apply]);

  const account = state?.channels.find((item) => item.channel === selected) ?? null;
  // reset the form only when the tab or the saved keys change, not on every refresh of other fields
  const draftKey = account ? [selected, account.app_id, account.organization_id, account.mode].join("|") : "";
  const [shownKey, setShownKey] = useState("");
  if (account && draftKey !== shownKey) {
    setShownKey(draftKey);
    setDraft(draftOf(account));
  }

  async function call(kind: string, url: string, method: "PUT" | "POST", body: unknown, done: (payload: Record<string, unknown>) => string) {
    setBusy(kind);
    setNote("");
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body ?? {}),
      });
      const payload = await readJson(response);
      if (!response.ok || !payload) {
        setNote(errorText(payload, "That did not work right now. Try again shortly."));
        return;
      }
      if (Array.isArray(payload.channels)) setState(payload as unknown as SocialChannelsState);
      setNote(done(payload));
    } catch {
      setNote("That did not work right now. Try again shortly.");
    } finally {
      setBusy("");
    }
  }

  function save(input: SocialChannelInput, message: string) {
    void call("save", API + "/" + selected, "PUT", input, () => message);
  }

  function saveKeys() {
    if (!draft || !account) return;
    const input: SocialChannelInput = { app_id: draft.app_id.trim() };
    if (draft.app_secret.trim()) input.app_secret = draft.app_secret.trim();
    if (selected === "x" && draft.consumer_secret.trim()) input.consumer_secret = draft.consumer_secret.trim();
    if (selected === "x" && draft.bearer_token.trim()) input.bearer_token = draft.bearer_token.trim();
    if (selected === "linkedin") input.organization_id = draft.organization_id.trim();
    save(input, "Keys saved. Now connect the account.");
  }

  async function connect() {
    setBusy("connect");
    setNote("");
    try {
      const response = await fetch(API + "/" + selected + "/connect", { method: "POST", credentials: "same-origin" });
      const payload = await readJson(response);
      if (response.ok && typeof payload?.url === "string" && payload.url.startsWith("https://")) {
        window.location.assign(payload.url);
        return;
      }
      setNote(errorText(payload, "Could not start the connection right now."));
    } catch {
      setNote("Could not start the connection right now.");
    }
    setBusy("");
  }

  function action(name: "test" | "webhook" | "sync" | "disconnect") {
    void call(name, API + "/" + selected + "/" + name, "POST", {}, (payload) => {
      if (name === "test") return "Connection works" + (payload.account_name ? " (" + String(payload.account_name) + ")" : "") + ".";
      if (name === "webhook") return "Webhook registered - new messages arrive in the inbox.";
      if (name === "sync")
        return payload.error ? String(payload.error) : "Checked: " + String(payload.received ?? 0) + " new, " + String(payload.sent ?? 0) + " sent.";
      return "Disconnected.";
    }).then(() => (name === "test" || name === "webhook" || name === "sync" ? load() : undefined));
  }

  function publish() {
    if (!postChannel) return;
    void call("post", API + "/posts", "POST", { channel: postChannel, text: postText, media_url: postMedia }, (payload) => {
      setPostText("");
      setPostMedia("");
      void load();
      return payload.status === "pending_approval" ? "Sent for approval." : "Post queued for publishing.";
    });
  }

  const canEdit = state?.can_edit === true;
  const mode: SocialMode = account?.mode ?? "api";
  const features = account ? account.capabilities[mode] : [];
  const publishable = (state?.channels ?? []).filter((item) => item.enabled && item.flags.publish && item.capabilities[item.mode].includes("publish"));

  return (
    <div id="social" className="mt-6 rounded-xl2 border border-line bg-white p-5 shadow-card">
      <h2 className="text-sm font-semibold text-ink">
        Social channels <span className="ml-1 text-[11px] font-normal text-brand">Early access</span>
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-ink-3">
        Messages and comments from these accounts arrive in the inbox with the same AI, approvals and opt-outs as every other
        channel. API mode uses your own developer app on each platform (keys are stored encrypted). Login mode runs the
        account&apos;s own session through the laptop bridge - unofficial, so the platform may limit the account.
      </p>

      <div className="mt-4 flex flex-wrap gap-2" role="tablist">
        {(state?.channels ?? []).map((item) => (
          <button
            key={item.channel}
            type="button"
            role="tab"
            aria-selected={item.channel === selected}
            onClick={() => setSelected(item.channel)}
            className={
              "rounded-lg border px-3 py-1.5 text-xs font-medium " +
              (item.channel === selected ? "border-brand/30 bg-brand/[0.06] text-brand" : "border-line bg-soft text-ink-3 hover:text-ink")
            }
          >
            {item.label}
            {item.enabled ? <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" /> : null}
          </button>
        ))}
      </div>

      {!loaded ? (
        <p className="mt-4 text-xs text-ink-3">Loading social channels...</p>
      ) : !state || !account || !draft ? null : (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {account.modes.map((value) => (
                <button
                  key={value}
                  type="button"
                  disabled={!canEdit || busy !== "" || account.modes.length < 2}
                  onClick={() => value !== mode && save({ mode: value }, value === "api" ? "API mode selected." : "Login mode selected.")}
                  className={
                    "rounded-lg border px-2.5 py-1 text-[11px] disabled:cursor-default " +
                    (value === mode ? "border-brand/30 bg-brand/[0.06] text-brand" : "border-line bg-soft text-ink-3")
                  }
                >
                  {value === "api" ? "API connection" : "Account login"}
                </button>
              ))}
              <span className={account.connected ? "text-ok" : "text-ink-3"}>
                {account.connected
                  ? (mode === "api" ? "Connected" : "Bridge online") + (account.account_name ? " - " + account.account_name : "")
                  : mode === "api"
                    ? "Not connected"
                    : "Bridge offline"}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={account.enabled}
              disabled={!canEdit || busy !== "" || (!account.enabled && mode === "api" && !account.connected)}
              onClick={() => save({ enabled: !account.enabled }, account.enabled ? account.label + " is off." : account.label + " is on.")}
              className={
                "rounded-lg border px-2.5 py-1 text-[11px] disabled:opacity-60 " +
                (account.enabled ? "border-emerald-400/25 bg-emerald-400/[0.08] text-ok" : "border-line bg-soft text-ink-3")
              }
            >
              {account.enabled ? "Channel on" : "Channel off"}
            </button>
          </div>

          <ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-ink-3">
            {account.limits.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>

          {mode === "api" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-[11px] text-ink-3">
                {selected === "tiktok" ? "App id" : "Client id"}
                <input className={INPUT + " mt-1"} value={draft.app_id} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, app_id: e.target.value })} />
              </label>
              <label className="text-[11px] text-ink-3">
                {selected === "tiktok" ? "App secret" : "Client secret"}
                <input
                  type="password"
                  className={INPUT + " mt-1"}
                  value={draft.app_secret}
                  placeholder={account.app_secret_masked || "Not set"}
                  disabled={!canEdit}
                  onChange={(e) => setDraft({ ...draft, app_secret: e.target.value })}
                />
              </label>
              {selected === "x" ? (
                <>
                  <label className="text-[11px] text-ink-3">
                    App bearer token (registers the webhook)
                    <input
                      type="password"
                      className={INPUT + " mt-1"}
                      value={draft.bearer_token}
                      placeholder={account.bearer_token_masked || "Not set"}
                      disabled={!canEdit}
                      onChange={(e) => setDraft({ ...draft, bearer_token: e.target.value })}
                    />
                  </label>
                  <label className="text-[11px] text-ink-3">
                    API key secret (verifies the webhook)
                    <input
                      type="password"
                      className={INPUT + " mt-1"}
                      value={draft.consumer_secret}
                      placeholder={account.consumer_secret_masked || "Not set"}
                      disabled={!canEdit}
                      onChange={(e) => setDraft({ ...draft, consumer_secret: e.target.value })}
                    />
                  </label>
                </>
              ) : null}
              {selected === "linkedin" ? (
                <label className="text-[11px] text-ink-3">
                  Company Page id (optional, for comment replies)
                  <input
                    className={INPUT + " mt-1"}
                    value={draft.organization_id}
                    inputMode="numeric"
                    disabled={!canEdit}
                    onChange={(e) => setDraft({ ...draft, organization_id: e.target.value })}
                  />
                </label>
              ) : null}
              <div className="flex flex-wrap items-end gap-2 sm:col-span-2">
                <button type="button" className={BUTTON} disabled={!canEdit || busy !== ""} onClick={saveKeys}>
                  {busy === "save" ? "Saving..." : "Save keys"}
                </button>
                <button
                  type="button"
                  className={BUTTON}
                  disabled={!canEdit || busy !== "" || !account.app_id || !account.app_secret_masked}
                  onClick={() => void connect()}
                >
                  {busy === "connect" ? "Opening..." : account.connected ? "Reconnect account" : "Connect account"}
                </button>
                {account.connected ? (
                  <>
                    <button type="button" className={BUTTON} disabled={!canEdit || busy !== ""} onClick={() => action("test")}>
                      {busy === "test" ? "Testing..." : "Test"}
                    </button>
                    <button
                      type="button"
                      className={BUTTON}
                      disabled={!canEdit || busy !== ""}
                      title={selected === "x" ? "Reads mentions and messages now - each read is billed by X" : undefined}
                      onClick={() => action("sync")}
                    >
                      {busy === "sync" ? "Checking..." : "Check now"}
                    </button>
                    {selected === "x" || selected === "tiktok" ? (
                      <button type="button" className={BUTTON} disabled={!canEdit || busy !== ""} onClick={() => action("webhook")}>
                        {busy === "webhook" ? "Registering..." : account.webhook_registered ? "Register webhook again" : "Register webhook"}
                      </button>
                    ) : null}
                    <button type="button" className={BUTTON} disabled={!canEdit || busy !== ""} onClick={() => action("disconnect")}>
                      Disconnect
                    </button>
                  </>
                ) : null}
              </div>
              {account.webhook_url ? (
                <p className="break-all text-[11px] text-ink-3 sm:col-span-2">
                  Webhook address (also paste it in your app settings if registering fails):{" "}
                  <span className="font-mono text-ink-2">{account.webhook_url}</span>
                </p>
              ) : null}
            </div>
          ) : (
            <div className="space-y-2 text-[11px] leading-relaxed text-ink-3">
              <p>
                Run <span className="font-mono text-ink-2">connector-node/social_login_bridge.py</span> on the laptop with{" "}
                <span className="font-mono text-ink-2">SOCIAL_LOGIN_CHANNELS</span> including{" "}
                <span className="font-mono text-ink-2">{selected === "telegram_user" ? "telegram" : selected}</span>. The account signs in
                on the laptop - its password never reaches OmniFlow.
              </p>
              <button type="button" className={BUTTON} disabled={!canEdit || busy !== ""} onClick={() => action("test")}>
                {busy === "test" ? "Checking..." : "Check bridge"}
              </button>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {features.map((feature) => (
              <button
                key={feature}
                type="button"
                role="switch"
                aria-checked={account.flags[feature]}
                disabled={!canEdit || busy !== ""}
                onClick={() => save({ flags: { [feature]: !account.flags[feature] } }, FEATURE_LABELS[feature] + (account.flags[feature] ? " off." : " on."))}
                className={
                  "rounded-lg border px-2.5 py-1 text-[11px] disabled:opacity-60 " +
                  (account.flags[feature] ? "border-emerald-400/25 bg-emerald-400/[0.08] text-ok" : "border-line bg-soft text-ink-3")
                }
              >
                {FEATURE_LABELS[feature]}: {account.flags[feature] ? "on" : "off"}
              </button>
            ))}
            {features.includes("comments") ? (
              <button
                type="button"
                role="switch"
                aria-checked={account.flags.comment_auto_reply}
                disabled={!canEdit || busy !== "" || !account.flags.comments}
                title="AI answers are posted publicly - only under your autonomy settings"
                onClick={() =>
                  save(
                    { flags: { comment_auto_reply: !account.flags.comment_auto_reply } },
                    account.flags.comment_auto_reply ? "AI comment replies off." : "AI comment replies on."
                  )
                }
                className={
                  "rounded-lg border px-2.5 py-1 text-[11px] disabled:opacity-60 " +
                  (account.flags.comment_auto_reply ? "border-emerald-400/25 bg-emerald-400/[0.08] text-ok" : "border-line bg-soft text-ink-3")
                }
              >
                AI comment replies: {account.flags.comment_auto_reply ? "on" : "off"}
              </button>
            ) : null}
          </div>

          {account.last_error ? <p className="text-[11px] text-danger">{account.last_error}</p> : null}
          <p className="text-[11px] text-ink-3">
            {[
              account.last_in_at ? "Last message in " + when(account.last_in_at) : "",
              account.last_sent_at ? "last sent " + when(account.last_sent_at) : "",
            ]
              .filter(Boolean)
              .join(", ")}
          </p>

          {publishable.length > 0 ? (
            <div className="border-t border-line pt-4">
              <h3 className="text-xs font-semibold text-ink">Publish a post</h3>
              <p className="mt-1 text-[11px] text-ink-3">
                {canEdit ? "Owners and admins publish directly." : "Your post waits for an owner's approval."} AI-drafted posts always need an
                approval.
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-[10rem_1fr]">
                <select className={INPUT + " self-start"} value={postChannel} onChange={(e) => setPostChannel(e.target.value as SocialChannelId | "")}>
                  <option value="">Channel</option>
                  {publishable.map((item) => (
                    <option key={item.channel} value={item.channel}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <textarea
                  className={INPUT + " min-h-20"}
                  value={postText}
                  maxLength={publishable.find((item) => item.channel === postChannel)?.post_max || 3000}
                  placeholder="What do you want to post?"
                  onChange={(e) => setPostText(e.target.value)}
                />
                {postChannel === "tiktok" ? (
                  <input
                    className={INPUT + " sm:col-start-2"}
                    value={postMedia}
                    placeholder="Public video URL (https://...)"
                    onChange={(e) => setPostMedia(e.target.value)}
                  />
                ) : null}
              </div>
              <button
                type="button"
                className={BUTTON + " mt-2"}
                disabled={busy !== "" || !postChannel || (!postText.trim() && postChannel !== "tiktok")}
                onClick={publish}
              >
                {busy === "post" ? "Sending..." : canEdit ? "Publish" : "Send for approval"}
              </button>
            </div>
          ) : null}

          {state.posts.length > 0 ? (
            <ul className="divide-y divide-line border-t border-line text-[11px]">
              {state.posts.map((post) => (
                <li key={post.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                  <span className="min-w-0 flex-1 truncate text-ink-2">
                    {state.channels.find((item) => item.channel === post.channel)?.label ?? post.channel}: {post.body}
                  </span>
                  <span className={post.status === "failed" ? "text-danger" : post.status === "published" ? "text-ok" : "text-ink-3"}>
                    {POST_STATUS[post.status] ?? post.status}
                    {post.error ? " - " + post.error : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      {note ? (
        <p className="mt-3 text-[11px] text-ink-2" role="status">
          {note}
        </p>
      ) : null}
    </div>
  );
}
