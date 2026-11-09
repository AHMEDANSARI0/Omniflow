"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { motion } from "motion/react";
import SocialConnectorsHub from "../../../components/portal/SocialConnectorsHub";

type ConnectorPlatform =
  | "instagram"
  | "facebook"
  | "tiktok"
  | "linkedin"
  | "whatsapp"
  | "x"
  | "youtube"
  | "telegram_user";

interface ClientUser {
  id: number;
  client_id?: number;
  workspace_name?: string;
  email: string;
  display_name: string | null;
  plan?: "Starter" | "Growth" | "Enterprise";
  status: string | null;
  last_login_at: string | null;
  failed_attempt_count: number;
  locked: boolean;
  allowed_channels?: ConnectorPlatform[];
  connected_channels?: ConnectorPlatform[];
  source?: "neon" | "control-plane";
}

interface CredentialBanner {
  title: string;
  workspace_id: number;
  workspace_name: string;
  email: string;
  temp_password: string;
}

interface ResetCode {
  user_id: number;
  email: string;
  code: string;
  expires_at: string;
  created_at: string;
}

const ALL_CHANNELS: { id: ConnectorPlatform; label: string }[] = [
  { id: "whatsapp", label: "WhatsApp" },
  { id: "instagram", label: "Instagram" },
  { id: "facebook", label: "Facebook" },
  { id: "tiktok", label: "TikTok" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "x", label: "X (Twitter)" },
  { id: "youtube", label: "YouTube" },
  { id: "telegram_user", label: "Telegram" },
];

function formatDate(value: string | null) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function randomClientPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "Of!";
  for (let i = 0; i < 9; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

export default function AdminCustomersPage() {
  const [users, setUsers] = useState<ClientUser[] | null>(null);
  const [resetCodes, setResetCodes] = useState<ResetCode[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [credentialBanner, setCredentialBanner] = useState<CredentialBanner | null>(null);
  const [selectedConnectorClient, setSelectedConnectorClient] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const [search, setSearch] = useState("");

  // Create Workspace Form State
  const [workspaceName, setWorkspaceName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState(() => randomClientPassword());
  const [plan, setPlan] = useState<"Starter" | "Growth" | "Enterprise">("Growth");
  const [accessStatus, setAccessStatus] = useState<"Active" | "Suspended">("Active");
  const [allowedChannels, setAllowedChannels] = useState<ConnectorPlatform[]>([
    "whatsapp",
    "instagram",
    "facebook",
    "tiktok",
    "linkedin",
  ]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [clientsResponse, codesResponse] = await Promise.all([
        fetch("/api/omniflow/admin/clients", {
          credentials: "same-origin",
          cache: "no-store",
        }),
        fetch("/api/omniflow/admin/reset-codes", {
          credentials: "same-origin",
          cache: "no-store",
        }),
      ]);

      const clientsPayload = await clientsResponse.json().catch(() => null);
      if (!clientsResponse.ok) {
        setError(
          clientsPayload?.error?.message ??
            "Could not load client workspaces. Please try again."
        );
        setUsers(null);
      } else {
        setUsers(
          Array.isArray(clientsPayload?.users) ? clientsPayload.users : []
        );
      }

      const codesPayload = await codesResponse.json().catch(() => null);
      setResetCodes(
        codesResponse.ok && Array.isArray(codesPayload?.codes)
          ? codesPayload.codes
          : []
      );
    } catch {
      setError("Network error — please try again.");
      setUsers(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleAllowedChannel(ch: ConnectorPlatform) {
    setAllowedChannels((prev) =>
      prev.includes(ch) ? prev.filter((item) => item !== ch) : [...prev, ch]
    );
  }

  async function handleCreateWorkspace(e: FormEvent) {
    e.preventDefault();
    if (creating) return;
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/omniflow/admin/clients", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_name: workspaceName.trim(),
          display_name: displayName.trim(),
          email: email.trim().toLowerCase(),
          password: password.trim(),
          plan,
          status: accessStatus,
          allowed_channels: allowedChannels,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.ok) {
        setError(payload?.error?.message ?? "Could not create workspace.");
        return;
      }
      if (Array.isArray(payload.users)) {
        setUsers(payload.users);
      } else {
        await load();
      }
      const createdUser = payload.user as ClientUser | undefined;
      const wsId = createdUser?.client_id ?? createdUser?.id ?? 101;
      const wsName =
        createdUser?.workspace_name || workspaceName.trim() || `Workspace #${wsId}`;
      setCredentialBanner({
        title: "Workspace Created & Customer Portal Access Granted",
        workspace_id: wsId,
        workspace_name: wsName,
        email: email.trim().toLowerCase(),
        temp_password: String(payload.temp_password || password.trim()),
      });
      setSelectedConnectorClient({ id: wsId, name: wsName });
      setWorkspaceName("");
      setDisplayName("");
      setEmail("");
      setPassword(randomClientPassword());
      setNotice(`Workspace "${wsName}" (#${wsId}) created with Customer Portal access.`);
    } catch {
      setError("Network error — could not create workspace.");
    } finally {
      setCreating(false);
    }
  }

  async function resetPassword(user: ClientUser) {
    setBusyId(user.id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/omniflow/admin/clients/${user.id}/reset-password`,
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? "Reset failed. Please try again.");
      } else {
        const wsId = user.client_id ?? user.id;
        setCredentialBanner({
          title: "New Customer Portal Password Generated",
          workspace_id: wsId,
          workspace_name: user.workspace_name || `Workspace #${wsId}`,
          email: payload?.email ?? user.email,
          temp_password: payload?.temp_password ?? "",
        });
        await load();
      }
    } catch {
      setError("Network error — reset failed. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function togglePortalAccess(user: ClientUser) {
    const nextLocked = !user.locked;
    setBusyId(user.id);
    setError(null);
    try {
      const res = await fetch("/api/omniflow/admin/clients", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: user.id,
          locked: nextLocked,
          status: nextLocked ? "Suspended" : "Active",
        }),
      });
      const payload = await res.json().catch(() => null);
      if (res.ok && Array.isArray(payload?.users)) {
        setUsers(payload.users);
        setNotice(
          nextLocked
            ? `Customer Portal access suspended for ${user.email}.`
            : `Customer Portal access granted for ${user.email}.`
        );
      } else {
        await load();
      }
    } catch {
      setError("Could not update portal access status.");
    } finally {
      setBusyId(null);
    }
  }

  async function openClientPortal(user: ClientUser) {
    const targetId = user.client_id ?? user.id;
    setBusyId(user.id);
    setError(null);
    try {
      const res = await fetch(`/api/omniflow/admin/clients/${targetId}/impersonate`, {
        method: "POST",
        credentials: "same-origin",
      });
      const payload = await res.json().catch(() => null);
      if (res.ok && payload?.ok) {
        window.open("/dashboard", "_blank", "noopener,noreferrer");
        setNotice(`Opened Customer Portal session for Workspace #${targetId} (${user.email}).`);
      } else {
        setError(payload?.error?.message ?? "Could not open Customer Portal session.");
      }
    } catch {
      setError("Network error while opening Customer Portal.");
    } finally {
      setBusyId(null);
    }
  }

  async function deleteWorkspace(user: ClientUser) {
    if (!window.confirm(`Delete workspace for "${user.email}"?`)) return;
    setBusyId(user.id);
    setError(null);
    try {
      const res = await fetch(`/api/omniflow/admin/clients?id=${user.id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const payload = await res.json().catch(() => null);
      if (res.ok && Array.isArray(payload?.users)) {
        setUsers(payload.users);
        setNotice(`Workspace for ${user.email} removed.`);
      } else {
        await load();
      }
    } catch {
      setError("Could not delete workspace.");
    } finally {
      setBusyId(null);
    }
  }

  async function copyValue(value: string, label = "Copied to clipboard.") {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(label);
    } catch {
      // Clipboard may be unavailable
    }
  }

  const allUsers = users ?? [];
  const filteredUsers = allUsers.filter((u) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      u.email.toLowerCase().includes(q) ||
      (u.display_name || "").toLowerCase().includes(q) ||
      (u.workspace_name || "").toLowerCase().includes(q) ||
      String(u.client_id ?? u.id).includes(q)
    );
  });

  const activeCount = allUsers.filter((u) => !u.locked).length;
  const lockedCount = allUsers.filter((u) => u.locked).length;
  const connectedTotal = allUsers.reduce(
    (sum, u) => sum + (Array.isArray(u.connected_channels) ? u.connected_channels.length : 0),
    0
  );

  const portalLoginUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/dashboard/login`
      : "https://omniflow-bice.vercel.app/dashboard/login";

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-brand">
            Admin Control Plane · Tenant Provisioning
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink">
            Client Workspaces, Portal Access & Social Connectors
          </h1>
          <p className="mt-1 text-sm text-ink-3">
            Create workspaces, grant or suspend Customer Portal access, and configure Instagram, Facebook, TikTok, LinkedIn & WhatsApp connectors per client.
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="rounded-xl border border-line bg-white px-4 py-2 text-xs font-medium text-ink-2 shadow-card transition-colors hover:border-brand/40"
        >
          Refresh
        </button>
      </div>

      {/* KPI Summary Strip */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border border-line bg-white px-5 py-4 shadow-card">
          <p className="text-[10px] uppercase tracking-wider text-ink-3">Total Workspaces</p>
          <p className="mt-1 text-2xl font-semibold text-ink">{allUsers.length}</p>
          <p className="mt-0.5 text-xs text-ink-3">Provisioned client accounts</p>
        </div>
        <div className="rounded-2xl border border-line bg-white px-5 py-4 shadow-card">
          <p className="text-[10px] uppercase tracking-wider text-ink-3">Portal Access Active</p>
          <p className="mt-1 text-2xl font-semibold text-ok">{activeCount}</p>
          <p className="mt-0.5 text-xs text-ink-3">Can sign in at /dashboard/login</p>
        </div>
        <div className="rounded-2xl border border-line bg-white px-5 py-4 shadow-card">
          <p className="text-[10px] uppercase tracking-wider text-ink-3">Suspended / Locked</p>
          <p className="mt-1 text-2xl font-semibold text-danger">{lockedCount}</p>
          <p className="mt-0.5 text-xs text-ink-3">Portal access paused</p>
        </div>
        <div className="rounded-2xl border border-line bg-white px-5 py-4 shadow-card">
          <p className="text-[10px] uppercase tracking-wider text-ink-3">Active Social Connectors</p>
          <p className="mt-1 text-2xl font-semibold text-brand">{connectedTotal}</p>
          <p className="mt-0.5 text-xs text-ink-3">IG, FB, TikTok, LinkedIn & WA</p>
        </div>
      </div>

      {error && (
        <motion.p
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          role="alert"
          className="rounded-xl border border-red-400/25 bg-red-400/[0.06] px-4 py-2.5 text-xs text-danger"
        >
          {error}
        </motion.p>
      )}

      {notice && (
        <motion.p
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          role="status"
          className="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.06] px-4 py-2.5 text-xs text-ok"
        >
          {notice}
        </motion.p>
      )}

      {/* Credential Banner after Workspace Creation or Password Reset */}
      {credentialBanner && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl border border-brand/30 bg-brand/[0.05] p-5 shadow-card"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-brand">
                {credentialBanner.title}
              </p>
              <p className="mt-1 text-sm font-medium text-ink">
                {credentialBanner.workspace_name} · Workspace ID #{credentialBanner.workspace_id}
              </p>
              <p className="mt-0.5 text-xs text-ink-3">
                Share these credentials with your client so they can sign into the Customer Portal.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCredentialBanner(null)}
              className="text-xs text-ink-3 hover:text-ink"
            >
              Dismiss
            </button>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-line bg-white px-3.5 py-2.5">
              <p className="text-[10px] uppercase tracking-wider text-ink-3">Portal Login URL</p>
              <p className="mt-1 truncate font-mono text-xs font-medium text-ink">{portalLoginUrl}</p>
            </div>
            <div className="rounded-xl border border-line bg-white px-3.5 py-2.5">
              <p className="text-[10px] uppercase tracking-wider text-ink-3">Workspace ID</p>
              <p className="mt-1 font-mono text-xs font-semibold text-ink">
                {credentialBanner.workspace_id}
              </p>
            </div>
            <div className="rounded-xl border border-line bg-white px-3.5 py-2.5">
              <p className="text-[10px] uppercase tracking-wider text-ink-3">Client Email</p>
              <p className="mt-1 truncate font-mono text-xs font-medium text-ink">
                {credentialBanner.email}
              </p>
            </div>
            <div className="rounded-xl border border-line bg-white px-3.5 py-2.5">
              <p className="text-[10px] uppercase tracking-wider text-ink-3">Password</p>
              <p className="mt-1 font-mono text-xs font-bold tracking-wider text-brand">
                {credentialBanner.temp_password}
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() =>
                void copyValue(
                  `OmniFlow Customer Portal Access\nWorkspace: ${credentialBanner.workspace_name} (ID: ${credentialBanner.workspace_id})\nLogin URL: ${portalLoginUrl}\nEmail: ${credentialBanner.email}\nPassword: ${credentialBanner.temp_password}`,
                  "Full client portal invite copied to clipboard!"
                )
              }
              className="rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90"
            >
              Copy Full Invite (WhatsApp / Email)
            </button>
            <button
              type="button"
              onClick={() =>
                void copyValue(credentialBanner.temp_password, "Password copied to clipboard!")
              }
              className="rounded-xl border border-line bg-white px-3.5 py-2 text-xs font-medium text-ink-2 hover:text-ink"
            >
              Copy Password Only
            </button>
            <button
              type="button"
              onClick={() =>
                void openClientPortal({
                  id: credentialBanner.workspace_id,
                  client_id: credentialBanner.workspace_id,
                  email: credentialBanner.email,
                  display_name: credentialBanner.workspace_name,
                  status: "Active",
                  last_login_at: null,
                  failed_attempt_count: 0,
                  locked: false,
                })
              }
              className="rounded-xl border border-brand/30 bg-brand-soft px-3.5 py-2 text-xs font-semibold text-brand hover:bg-brand/15"
            >
              Open Customer Portal as this Client →
            </button>
          </div>
        </motion.div>
      )}

      {/* Create Workspace & Grant Customer Portal Access Panel */}
      <form
        onSubmit={handleCreateWorkspace}
        className="rounded-2xl border border-line bg-white p-6 shadow-card"
      >
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-ink">
              Create Client Workspace & Grant Customer Portal Access
            </h2>
            <p className="mt-0.5 text-xs text-ink-3">
              Provision a dedicated tenant workspace so your client can sign in at{" "}
              <span className="font-mono text-ink-2">/dashboard/login</span> and manage their AI bot & social channels.
            </p>
          </div>
          <span className="rounded-lg border border-brand/25 bg-brand-soft px-2.5 py-1 text-[11px] font-medium text-brand">
            Instant Provisioning
          </span>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-2">
              Workspace / Business Name *
            </span>
            <input
              required
              value={workspaceName}
              onChange={(e) => setWorkspaceName(e.target.value)}
              placeholder="e.g. StylePK Apparel"
              className="w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-xs text-ink placeholder:text-ink-3 outline-none focus:border-brand/40"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-2">
              Client Full Name *
            </span>
            <input
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Ali Raza"
              className="w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-xs text-ink placeholder:text-ink-3 outline-none focus:border-brand/40"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-2">
              Client Login Email *
            </span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="client@business.com"
              className="w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-xs text-ink placeholder:text-ink-3 outline-none focus:border-brand/40"
            />
          </label>

          <div>
            <span className="mb-1 block text-xs font-medium text-ink-2">
              Initial Portal Password *
            </span>
            <div className="flex gap-2">
              <input
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="8+ characters"
                className="w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 font-mono text-xs text-ink outline-none focus:border-brand/40"
              />
              <button
                type="button"
                onClick={() => setPassword(randomClientPassword())}
                className="shrink-0 rounded-xl border border-line bg-soft px-3 py-2 text-[11px] font-medium text-ink-2 hover:text-ink"
              >
                Generate
              </button>
            </div>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-2">
              Subscription Plan
            </span>
            <select
              value={plan}
              onChange={(e) => setPlan(e.target.value as "Starter" | "Growth" | "Enterprise")}
              className="w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-xs text-ink outline-none focus:border-brand/40"
            >
              <option value="Starter">Starter Plan</option>
              <option value="Growth">Growth Plan</option>
              <option value="Enterprise">Enterprise Plan</option>
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-2">
              Customer Portal Access
            </span>
            <select
              value={accessStatus}
              onChange={(e) => setAccessStatus(e.target.value as "Active" | "Suspended")}
              className="w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-xs text-ink outline-none focus:border-brand/40"
            >
              <option value="Active">Active (Full Portal Access)</option>
              <option value="Suspended">Suspended (Access Paused)</option>
            </select>
          </label>
        </div>

        <div className="mt-4">
          <span className="mb-2 block text-xs font-medium text-ink-2">
            Enabled Social & Messaging Connectors for this Workspace
          </span>
          <div className="flex flex-wrap gap-2">
            {ALL_CHANNELS.map((ch) => {
              const picked = allowedChannels.includes(ch.id);
              return (
                <button
                  key={ch.id}
                  type="button"
                  onClick={() => toggleAllowedChannel(ch.id)}
                  className={
                    "rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors " +
                    (picked
                      ? "border-brand/35 bg-brand/[0.08] text-brand"
                      : "border-line bg-soft text-ink-3 hover:text-ink")
                  }
                >
                  {picked ? "✓ " : "+ "}
                  {ch.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <p className="text-[11px] text-ink-3">
            Once created, you can immediately copy the client login invite or open their Customer Portal & configure their social connectors below.
          </p>
          <button
            type="submit"
            disabled={creating}
            className="rounded-xl bg-brand px-5 py-2.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {creating ? "Creating Workspace…" : "Create Workspace & Grant Portal Access"}
          </button>
        </div>
      </form>

      {resetCodes && resetCodes.length > 0 && (
        <div className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.04] p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-amber-700">
            Recent password reset codes
          </p>
          <div className="mt-2 space-y-2">
            {resetCodes.map((entry) => (
              <div
                key={`${entry.user_id}-${entry.created_at}`}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2"
              >
                <span className="text-xs text-ink-2">{entry.email}</span>
                <code className="rounded-md border border-line bg-canvas px-2.5 py-1 text-xs font-semibold tracking-[0.3em] text-ink">
                  {entry.code}
                </code>
                <button
                  onClick={() => void copyValue(entry.code, "Reset code copied.")}
                  className="rounded-md bg-amber-400/90 px-2 py-1 text-[10px] font-semibold text-white"
                >
                  Copy
                </button>
                <span className="ml-auto text-[10px] text-ink-3">
                  expires {formatDate(entry.expires_at)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Client Workspaces Table */}
      <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">
              Provisioned Client Workspaces ({filteredUsers.length})
            </h2>
            <p className="text-xs text-ink-3">
              Manage Customer Portal access, reset passwords, or configure Instagram, Facebook, TikTok & LinkedIn connectors.
            </p>
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search workspace, email, or ID…"
            className="w-full sm:w-64 rounded-xl border border-line bg-soft px-3.5 py-2 text-xs text-ink placeholder:text-ink-3 outline-none focus:border-brand/40"
          />
        </div>

        {loading ? (
          <div className="px-5 py-10 text-center text-sm text-ink-3">
            Loading client workspaces…
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-ink-3">
            No client workspaces found. Use the form above to create your first client workspace.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line bg-soft/40 text-[11px] uppercase tracking-wider text-ink-3">
                  <th className="px-4 py-3 font-medium">Workspace</th>
                  <th className="px-4 py-3 font-medium">Client Account</th>
                  <th className="px-4 py-3 font-medium">Portal Access</th>
                  <th className="px-4 py-3 font-medium">Social Connectors</th>
                  <th className="px-4 py-3 font-medium">Last Login</th>
                  <th className="px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map((u) => {
                  const wsId = u.client_id ?? u.id;
                  const wsName = u.workspace_name || `Workspace #${wsId}`;
                  const connected = new Set(u.connected_channels ?? []);
                  const isSelected = selectedConnectorClient?.id === wsId;

                  return (
                    <tr
                      key={`${u.source || "cp"}-${u.id}`}
                      className="border-b border-line last:border-0 hover:bg-soft/30"
                    >
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-2">
                          <span className="rounded-md border border-brand/25 bg-brand-soft px-2 py-0.5 font-mono text-[11px] font-semibold text-brand">
                            #{wsId}
                          </span>
                          <span className="font-medium text-ink">{wsName}</span>
                        </div>
                        <span className="mt-1 inline-block rounded bg-soft px-2 py-0.5 text-[10px] font-medium text-ink-3">
                          {u.plan || "Growth"} Plan
                        </span>
                      </td>
                      <td className="px-4 py-3.5">
                        <p className="font-medium text-ink">{u.display_name || "—"}</p>
                        <p className="text-xs text-ink-3">{u.email}</p>
                      </td>
                      <td className="px-4 py-3.5">
                        {u.locked ? (
                          <span className="rounded-md border border-red-400/25 bg-red-400/[0.07] px-2.5 py-1 text-[11px] font-medium text-danger">
                            Suspended / Locked
                          </span>
                        ) : (
                          <span className="rounded-md border border-emerald-400/25 bg-emerald-400/[0.08] px-2.5 py-1 text-[11px] font-medium text-ok">
                            Active Access
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3.5">
                        <div className="flex flex-wrap gap-1">
                          {(
                            [
                              { id: "instagram", short: "IG" },
                              { id: "facebook", short: "FB" },
                              { id: "tiktok", short: "TikTok" },
                              { id: "linkedin", short: "LinkedIn" },
                              { id: "whatsapp", short: "WA" },
                              { id: "x", short: "X" },
                              { id: "youtube", short: "YT" },
                              { id: "telegram_user", short: "TG" },
                            ] as const
                          ).map((item) => {
                            const on = connected.has(item.id);
                            return (
                              <span
                                key={item.id}
                                className={
                                  "rounded border px-1.5 py-0.5 text-[10px] font-medium " +
                                  (on
                                    ? "border-emerald-400/30 bg-emerald-400/10 text-ok"
                                    : "border-line bg-soft text-ink-3")
                                }
                              >
                                {item.short}
                              </span>
                            );
                          })}
                        </div>
                      </td>
                      <td className="px-4 py-3.5 text-xs text-ink-3">
                        {formatDate(u.last_login_at)}
                      </td>
                      <td className="px-4 py-3.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => void openClientPortal(u)}
                            disabled={busyId === u.id}
                            className="rounded-lg bg-brand px-2.5 py-1.5 text-[11px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                          >
                            Open Portal
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setSelectedConnectorClient(
                                isSelected ? null : { id: wsId, name: wsName }
                              )
                            }
                            className={
                              "rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors " +
                              (isSelected
                                ? "border-brand bg-brand/10 text-brand"
                                : "border-line bg-white text-ink-2 hover:border-brand/40")
                            }
                          >
                            {isSelected ? "Hide Connectors" : "Connectors"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void togglePortalAccess(u)}
                            disabled={busyId === u.id}
                            className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-[11px] font-medium text-ink-2 hover:text-ink disabled:opacity-50"
                          >
                            {u.locked ? "Grant Access" : "Suspend"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void resetPassword(u)}
                            disabled={busyId === u.id}
                            className="rounded-lg border border-brand/25 bg-brand-soft px-2.5 py-1.5 text-[11px] font-medium text-brand hover:bg-brand/[0.12] disabled:opacity-50"
                          >
                            Reset Password
                          </button>
                          {u.source === "neon" && (
                            <button
                              type="button"
                              onClick={() => void deleteWorkspace(u)}
                              disabled={busyId === u.id}
                              className="rounded-lg border border-red-400/25 bg-red-400/5 px-2 py-1.5 text-[11px] font-medium text-danger hover:bg-red-400/10 disabled:opacity-50"
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Inline Workspace Social Connectors Configurator */}
      {selectedConnectorClient && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">
              Configuring Social Connectors for {selectedConnectorClient.name} (#{selectedConnectorClient.id})
            </h3>
            <button
              type="button"
              onClick={() => {
                setSelectedConnectorClient(null);
                void load();
              }}
              className="text-xs font-medium text-ink-3 hover:text-ink"
            >
              Close Connectors Panel ✕
            </button>
          </div>
          <SocialConnectorsHub
            adminClientId={selectedConnectorClient.id}
            workspaceLabel={selectedConnectorClient.name}
          />
        </div>
      )}
    </div>
  );
}
