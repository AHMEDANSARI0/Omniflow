"use client";

import { useCallback, useEffect, useState } from "react";
import { INTEGRATIONS } from "../../../../lib/marketing/integrations";
import MetaSetupPanel from "./MetaSetupPanel";

// §228: one Meta connection - Instagram DMs, Facebook Messenger and comments
// on Instagram / Facebook posts. Other social channels are listed honestly
// as coming soon (no fake connectors).

type MetaState = {
  accountId: string;
  pageId: string;
  enabled: boolean;
  configured: boolean;
  messengerEnabled: boolean;
  commentsEnabled: boolean;
  commentAutoReply: boolean;
  accessTokenMasked: string;
  pageAccessTokenMasked: string;
  appSecretMasked: string;
  verifyTokenMasked: string;
  webhookPath: string;
  lastCheckAt: string | null;
  lastError: string | null;
  cpSends: boolean;
  lastSentAt: string | null;
  sendError: string | null;
};

const EMPTY: MetaState = {
  accountId: "",
  pageId: "",
  enabled: false,
  configured: false,
  messengerEnabled: false,
  commentsEnabled: false,
  commentAutoReply: false,
  accessTokenMasked: "",
  pageAccessTokenMasked: "",
  appSecretMasked: "",
  verifyTokenMasked: "",
  webhookPath: "/api/v1/public/meta/webhook",
  lastCheckAt: null,
  lastError: null,
  cpSends: false,
  lastSentAt: null,
  sendError: null,
};

// the same honest availability list the marketing site uses
const COMING_SOON = INTEGRATIONS.filter(
  (item) => item.category === "channels" && item.status === "soon"
).map((item) => item.name);

const INPUT =
  "mt-1 w-full rounded-lg border border-line bg-soft px-2 py-1.5 text-xs text-ink focus:border-white/20 focus:outline-none";

function SecretField(props: {
  label: string;
  masked: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  hint?: string;
  wide?: boolean;
}) {
  return (
    <label className={"block" + (props.wide ? " sm:col-span-2" : "")}>
      <span className="text-[11px] text-ink-3">
        {props.label} {props.masked ? "(" + props.masked + ")" : ""}
      </span>
      <input
        type="password"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.masked ? "Leave blank to keep the saved value" : props.placeholder}
        autoComplete="new-password"
        className={INPUT}
      />
      {props.hint ? <span className="mt-1 block text-[10px] text-ink-3">{props.hint}</span> : null}
    </label>
  );
}

function Toggle(props: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label
      className={
        "flex items-start gap-2 rounded-lg border border-line bg-soft px-3 py-2 " +
        (props.disabled ? "opacity-50" : "")
      }
    >
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
        className="mt-0.5"
      />
      <span>
        <span className="block text-xs text-ink">{props.label}</span>
        <span className="block text-[10px] text-ink-3">{props.hint}</span>
      </span>
    </label>
  );
}

export default function InstagramCard() {
  const [settings, setSettings] = useState<MetaState>(EMPTY);
  const [accessToken, setAccessToken] = useState("");
  const [pageAccessToken, setPageAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/instagram/settings", {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (payload && payload.settings) {
        setSettings({ ...EMPTY, ...payload.settings });
      }
    } catch {
      setNote("Could not load the Meta settings.");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function set<K extends keyof MetaState>(key: K, value: MetaState[K]) {
    setSettings((old) => ({ ...old, [key]: value }));
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/instagram/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: Boolean(settings.accountId.trim() || settings.pageId.trim()),
          account_id: settings.accountId.trim(),
          page_id: settings.pageId.trim(),
          access_token: accessToken.trim(),
          page_access_token: pageAccessToken.trim(),
          app_secret: appSecret.trim(),
          verify_token: verifyToken.trim(),
          messenger_enabled: settings.messengerEnabled,
          comments_enabled: settings.commentsEnabled,
          comment_auto_reply: settings.commentsEnabled && settings.commentAutoReply,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.error) {
        setNote(payload?.error?.message || "Could not save the Meta settings.");
        return;
      }
      setAccessToken("");
      setPageAccessToken("");
      setAppSecret("");
      setVerifyToken("");
      setNote(
        payload.requiresCheck === false
          ? "Saved."
          : "Saved. Verify with Meta before messages are accepted."
      );
      await load();
    } catch {
      setNote("Could not save the Meta settings.");
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/instagram/test", {
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.error) {
        setNote(payload?.error?.message || "Meta verification failed.");
        await load();
        return;
      }
      const parts: string[] = [];
      if (payload.profile?.username) parts.push("@" + payload.profile.username);
      if (payload.page?.name) parts.push(payload.page.name);
      setNote(parts.length ? "Verified with Meta for " + parts.join(" and ") + "." : "Verified with Meta.");
      await load();
    } catch {
      setNote("Meta verification failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) {
    return (
      <section className="mt-6 rounded-2xl border border-line bg-white shadow-card p-5">
        <h2 className="text-sm font-medium text-ink">Instagram, Messenger and comments</h2>
        <p className="mt-0.5 text-xs text-ink-3">Loading...</p>
      </section>
    );
  }

  return (
    <section className="mt-6 rounded-2xl border border-line bg-white shadow-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-ink">Instagram, Messenger and comments</h2>
          <p className="mt-0.5 text-xs text-ink-3">
            Connect your Instagram Professional account and Facebook Page through Meta. Messages
            and comments arrive in the same inbox and use the same AI and workflows.
          </p>
        </div>
        <span
          className={
            "rounded-md border px-2 py-0.5 text-[10px] " +
            (settings.enabled
              ? "border-emerald-400/25 bg-emerald-400/[0.08] text-ok"
              : "border-line bg-soft text-ink-3")
          }
        >
          {settings.enabled ? "Verified" : "Not verified"}
        </span>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-[11px] text-ink-3">Instagram account ID</span>
          <input
            value={settings.accountId}
            onChange={(event) => set("accountId", event.target.value)}
            placeholder="Instagram Professional account ID"
            autoComplete="off"
            className={INPUT}
          />
        </label>
        <label className="block">
          <span className="text-[11px] text-ink-3">Facebook Page ID</span>
          <input
            value={settings.pageId}
            onChange={(event) => set("pageId", event.target.value)}
            placeholder="Needed for Messenger and Facebook comments"
            autoComplete="off"
            className={INPUT}
          />
        </label>
        <SecretField
          label="Access token"
          masked={settings.accessTokenMasked}
          value={accessToken}
          onChange={setAccessToken}
          placeholder="Meta access token"
        />
        <SecretField
          label="Page access token (optional)"
          masked={settings.pageAccessTokenMasked}
          value={pageAccessToken}
          onChange={setPageAccessToken}
          placeholder="Only if the Page uses a different token"
        />
        <SecretField
          label="App secret"
          masked={settings.appSecretMasked}
          value={appSecret}
          onChange={setAppSecret}
          placeholder="Meta app secret"
        />
        <SecretField
          label="Webhook verify token"
          masked={settings.verifyTokenMasked}
          value={verifyToken}
          onChange={setVerifyToken}
          placeholder="A private token you also enter in Meta"
        />
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <Toggle
          label="Facebook Messenger"
          hint="Page messages arrive as Messenger conversations."
          checked={settings.messengerEnabled}
          onChange={(value) => set("messengerEnabled", value)}
        />
        <Toggle
          label="Comments on posts"
          hint="New comments arrive in the inbox. Your reply is posted publicly under the comment."
          checked={settings.commentsEnabled}
          onChange={(value) => set("commentsEnabled", value)}
        />
        <Toggle
          label="AI answers comments"
          hint="Off: comments wait for your team. On: the AI replies publicly when AI autonomy is Auto."
          checked={settings.commentsEnabled && settings.commentAutoReply}
          disabled={!settings.commentsEnabled}
          onChange={(value) => set("commentAutoReply", value)}
        />
      </div>

      <div className="mt-4 rounded-lg border border-line bg-soft px-3 py-2 text-[11px] text-ink-3">
        <p>
          Webhook URL in Meta: your Control Plane address followed by{" "}
          <span className="font-mono text-ink-2">{settings.webhookPath}</span>
        </p>
        <p className="mt-1">
          Subscribe the Instagram object to <span className="text-ink-2">messages</span> and{" "}
          <span className="text-ink-2">comments</span>, and the Page object to{" "}
          <span className="text-ink-2">messages</span> and <span className="text-ink-2">feed</span>.
          The setup check below can register the webhooks and subscribe the Page for you.
          Automated campaigns and follow-ups are never posted as public comments.
        </p>
        {settings.cpSends ? (
          <p className="mt-1">
            Replies are sent by the Control Plane, so no laptop bridge is needed.
            {settings.lastSentAt ? " Last reply sent: " + settings.lastSentAt + "." : ""}
          </p>
        ) : null}
      </div>

      <MetaSetupPanel disabled={!settings.configured} />

      {settings.lastError ? (
        <p className="mt-3 text-[11px] text-danger">Last provider error: {settings.lastError}</p>
      ) : null}
      {settings.sendError ? (
        <p className="mt-2 text-[11px] text-danger">Replies: {settings.sendError}</p>
      ) : null}
      {settings.lastCheckAt ? (
        <p className="mt-2 text-[10px] text-ink-3">Last verified: {settings.lastCheckAt}</p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded-lg border border-brand/30 bg-brand-soft px-3 py-1.5 text-xs text-brand hover:bg-brand-soft disabled:opacity-50"
        >
          {busy ? "Saving..." : "Save configuration"}
        </button>
        <button
          onClick={() => void verify()}
          disabled={busy || !settings.configured}
          className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-white/[0.06] disabled:opacity-50"
        >
          Verify with Meta
        </button>
        {note ? <span className="text-[11px] text-ink-3">{note}</span> : null}
      </div>

      {COMING_SOON.length ? (
        <div className="mt-5 border-t border-line pt-4">
          <p className="text-[11px] text-ink-3">Other social channels</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {COMING_SOON.map((name) => (
              <span
                key={name}
                className="rounded-md border border-line bg-soft px-2 py-1 text-[11px] text-ink-3"
              >
                {name} <span className="text-[10px]">Coming soon</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
