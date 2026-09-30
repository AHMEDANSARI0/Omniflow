"use client";

import { useCallback, useEffect, useState } from "react";

type Risk = "low" | "medium" | "high";

interface Agent {
  id: number;
  name: string;
  tone: string;
  instructions: string;
  escalationUserId: number | null;
  isActive: boolean;
  versions: number;
  allowedActions: string[] | null;
  maxRisk: Risk;
  canAutoReply: boolean;
}

interface CatalogAction {
  action: string;
  description: string;
  risk: Risk;
}

interface AgentVersion {
  version: number;
  note: string;
  createdAt: string;
  snapshot: {
    name: string;
    tone: string;
    instructions: string;
    allowedActions: string[] | null;
    maxRisk: Risk;
    canAutoReply: boolean;
    restoredFrom: number | null;
  };
}

const RISK_LABEL: Record<Risk, string> = {
  low: "Low",
  medium: "Medium",
  high: "High (approval required)",
};

function permissionSummary(agent: Agent): string {
  const actions =
    agent.allowedActions === null
      ? "all actions"
      : agent.allowedActions.length === 0
      ? "no actions"
      : agent.allowedActions.length +
        " action" +
        (agent.allowedActions.length === 1 ? "" : "s");
  const risk = "max risk " + agent.maxRisk;
  const reply = agent.canAutoReply ? "auto-reply on" : "drafts only";
  return actions + " \u00b7 " + risk + " \u00b7 " + reply;
}

function formatWhen(value: string): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

interface Rule {
  id: number;
  match: string;
  userId: number;
  priority: number;
  targetType: "user" | "agent";
  agentId: number | null;
  agentName: string | null;
}

interface TeamMember {
  id: number;
  name: string;
}

const inputClass =
  "w-full rounded-xl border border-line bg-soft px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-3 outline-none transition-colors duration-300 focus:border-brand/40";

const primaryBtn =
  "rounded-xl border border-brand/25 bg-brand-soft px-4 py-2 text-xs font-medium text-brand transition-colors duration-300 hover:bg-brand-soft disabled:opacity-50";

function StatusChip({ active }: { active: boolean }) {
  return (
    <span
      className={
        "rounded-full border px-2 py-0.5 text-[11px] font-medium " +
        (active
          ? "border-emerald-400/30 bg-emerald-400/10 text-ok"
          : "border-line-2 bg-soft text-ink-3")
      }
    >
      {active ? "Active" : "Archived"}
    </span>
  );
}

export default function AgentsAndRouting() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  // agent form
  const [name, setName] = useState("");
  const [tone, setTone] = useState("");
  const [instructions, setInstructions] = useState("");
  const [escalation, setEscalation] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // permission envelope (AI never bypasses app permissions)
  const [allowAll, setAllowAll] = useState(true);
  const [allowedActions, setAllowedActions] = useState<string[]>([]);
  const [maxRisk, setMaxRisk] = useState<Risk>("high");
  const [canAutoReply, setCanAutoReply] = useState(true);
  const [schedule, setSchedule] = useState<AgentSchedule>(defaultSchedule);
  const [catalog, setCatalog] = useState<CatalogAction[]>([]);

  // version history + rollback
  const [versionsFor, setVersionsFor] = useState<number | null>(null);
  const [versions, setVersions] = useState<AgentVersion[] | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);

  // routing form
  const [match, setMatch] = useState("");
  const [targetType, setTargetType] = useState<"user" | "agent">("user");
  const [userId, setUserId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [priority, setPriority] = useState("100");
  const [addingRule, setAddingRule] = useState(false);

  const load = useCallback(async () => {
    try {
      const [agentsRes, rulesRes, membersRes, catalogRes] = await Promise.all([
        fetch("/api/omniflow/portal/agents", { cache: "no-store" }),
        fetch("/api/omniflow/portal/routing/rules", { cache: "no-store" }),
        fetch("/api/omniflow/portal/team", { cache: "no-store" }),
        fetch("/api/omniflow/portal/workflows/catalog", { cache: "no-store" }),
      ]);
      if (catalogRes.ok) {
        const payload = (await catalogRes.json()) as {
          catalog?: { actions?: CatalogAction[] };
        };
        setCatalog(payload.catalog?.actions ?? []);
      }
      if (agentsRes.ok) {
        const payload = (await agentsRes.json()) as { agents?: Agent[] };
        const rows = (payload.agents ?? []).map((agent) => ({
          ...agent,
          schedule: normalizeSchedule(agent.schedule),
          inHours: agent.inHours !== false,
          canAutoReply: agent.canAutoReply !== false,
        }));
        setAgents(rows);
      }
      if (rulesRes.ok) {
        const payload = (await rulesRes.json()) as { rules?: Rule[] };
        setRules(payload.rules ?? []);
      }
      if (membersRes.ok) {
        const payload = (await membersRes.json()) as {
          members?: TeamMember[];
        };
        setMembers(payload.members ?? []);
      }
    } catch {
      // fail-soft: sections just stay empty
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function flash(text: string) {
    setNotice(text);
    window.setTimeout(() => setNotice(null), 2600);
  }

  async function saveAgent(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        tone: tone.trim(),
        instructions: instructions.trim(),
        escalation_user_id: escalation.trim()
          ? Number.parseInt(escalation, 10)
          : null,
        allowed_actions: allowAll ? null : allowedActions,
        max_risk: maxRisk,
        can_auto_reply: canAutoReply,
        schedule,
      };
      const response = await fetch(
        editingId
          ? "/api/omniflow/portal/agents/" + editingId
          : "/api/omniflow/portal/agents",
        {
          method: editingId ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            editingId ? { ...payload, is_active: true } : payload
          ),
        }
      );
      if (response.ok) {
        resetForm();
        flash(editingId ? "Agent updated." : "Agent created.");
        await load();
        if (versionsFor !== null) await openVersions(versionsFor);
      } else {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        flash(body?.error?.message ?? "Could not save the agent.");
      }
    } catch {
      flash("Could not save the agent.");
    } finally {
      setSaving(false);
    }
  }

  function resetForm() {
    setEditingId(null);
    setName("");
    setTone("");
    setInstructions("");
    setEscalation("");
    setAllowAll(true);
    setAllowedActions([]);
    setMaxRisk("high");
    setCanAutoReply(true);
    setSchedule(defaultSchedule());
  }

  function startEdit(agent: Agent) {
    setEditingId(agent.id);
    setName(agent.name);
    setTone(agent.tone);
    setInstructions(agent.instructions);
    setEscalation(
      agent.escalationUserId != null ? String(agent.escalationUserId) : ""
    );
    setAllowAll(agent.allowedActions === null);
    setAllowedActions(agent.allowedActions ?? []);
    setMaxRisk(agent.maxRisk);
    setCanAutoReply(agent.canAutoReply);
    setSchedule(normalizeSchedule(agent.schedule));
  }

  function cancelEdit() {
    resetForm();
  }

  function toggleAction(action: string) {
    setAllowedActions((current) =>
      current.includes(action)
        ? current.filter((item) => item !== action)
        : [...current, action]
    );
  }

  async function openVersions(id: number) {
    setVersionsFor(id);
    setVersions(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/agents/" + id + "/versions",
        { cache: "no-store" }
      );
      if (response.ok) {
        const payload = (await response.json()) as {
          versions?: AgentVersion[];
        };
        setVersions(payload.versions ?? []);
      } else {
        setVersions([]);
      }
    } catch {
      setVersions([]);
    }
  }

  async function toggleVersions(id: number) {
    if (versionsFor === id) {
      setVersionsFor(null);
      setVersions(null);
      return;
    }
    await openVersions(id);
  }

  async function restoreVersion(id: number, version: number) {
    setRestoring(version);
    try {
      const response = await fetch(
        "/api/omniflow/portal/agents/" + id + "/rollback",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version }),
        }
      );
      if (response.ok) {
        const payload = (await response.json()) as { version?: number };
        flash(
          "Restored version " +
            version +
            " as version " +
            (payload.version ?? "") +
            "."
        );
        if (editingId === id) resetForm();
        await load();
        await openVersions(id);
      } else {
        flash("Could not restore that version.");
      }
    } catch {
      flash("Could not restore that version.");
    } finally {
      setRestoring(null);
    }
  }

  async function archive(id: number) {
    try {
      const response = await fetch("/api/omniflow/portal/agents/" + id, {
        method: "DELETE",
      });
      if (response.ok) {
        flash("Agent archived.");
        await load();
      }
    } catch {
      flash("Could not archive the agent.");
    }
  }

  async function addRule(event: React.FormEvent) {
    event.preventDefault();
    if (!match.trim()) return;
    if (targetType === "agent" && !agentId.trim()) return;
    if (targetType === "user" && !userId.trim()) return;
    setAddingRule(true);
    try {
      const parsedUser = Number.parseInt(userId || "0", 10);
      const parsedAgent = Number.parseInt(agentId || "0", 10);
      const parsedPriority = Number.parseInt(priority || "100", 10);
      const response = await fetch("/api/omniflow/portal/routing/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          match: match.trim(),
          user_id: targetType === "user" ? parsedUser : 0,
          target_type: targetType,
          agent_id: targetType === "agent" ? parsedAgent : null,
          priority: Number.isFinite(parsedPriority) ? parsedPriority : 100,
        }),
      });
      if (response.ok) {
        setMatch("");
        setUserId("");
        setAgentId("");
        setPriority("100");
        flash("Routing rule added.");
        await load();
      } else {
        flash("Could not add the rule.");
      }
    } catch {
      flash("Could not add the rule.");
    } finally {
      setAddingRule(false);
    }
  }

  async function removeRule(rule: Rule) {
    try {
      const response = await fetch(
        "/api/omniflow/portal/routing/rules?id=" + rule.id,
        { method: "DELETE" }
      );
      if (response.ok) {
        flash("Rule removed.");
        await load();
      }
    } catch {
      flash("Could not remove the rule.");
    }
  }

  const activeAgents = (agents ?? []).filter((agent) => agent.isActive);

  return (
    <div className="mt-10">
      <div className="mb-5">
        <h2 className="text-lg font-semibold tracking-tight text-ink">
          AI agents &amp; routing
        </h2>
        <p className="mt-1 text-sm text-ink-3">
          Create AI agents with a persona, then route inbound chats to them (or
          to a teammate) with keyword rules.
        </p>
      </div>

      {notice ? (
        <div className="mb-4 rounded-xl border border-line bg-white px-4 py-2.5 text-sm text-ink-2">
          {notice}
        </div>
      ) : null}

      <div className="space-y-6">
        {/* ---------- AI Agents ---------- */}
        <div className="rounded-2xl border border-line bg-white p-5">
          <h3 className="text-sm font-semibold text-ink">AI agents</h3>
          <p className="mt-1 text-xs text-ink-3">
            A named AI persona the Business Brain follows when a conversation
            is routed to it.
          </p>

          <form onSubmit={saveAgent} className="mt-4 space-y-3">
            <div>
              <label
                htmlFor="agent_name"
                className="mb-1 block text-xs font-medium text-ink-3"
              >
                Name
              </label>
              <input
                id="agent_name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Sales Aunty"
                maxLength={60}
                className={inputClass}
              />
            </div>
            <div>
              <label
                htmlFor="agent_tone"
                className="mb-1 block text-xs font-medium text-ink-3"
              >
                Tone
              </label>
              <input
                id="agent_tone"
                value={tone}
                onChange={(event) => setTone(event.target.value)}
                placeholder="Warm and persuasive, ends with a soft upsell"
                maxLength={120}
                className={inputClass}
              />
            </div>
            <div>
              <label
                htmlFor="agent_instructions"
                className="mb-1 block text-xs font-medium text-ink-3"
              >
                Instructions
              </label>
              <textarea
                id="agent_instructions"
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder="Free-form guidance the agent follows (focus, limits, style)."
                rows={3}
                maxLength={1000}
                className={inputClass}
              />
            </div>
            <div>
              <label
                htmlFor="agent_escalation"
                className="mb-1 block text-xs font-medium text-ink-3"
              >
                Escalate to teammate (user id, optional)
              </label>
              <input
                id="agent_escalation"
                value={escalation}
                onChange={(event) => setEscalation(event.target.value)}
                placeholder="Leave empty for no escalation"
                inputMode="numeric"
                className={inputClass}
              />
            </div>

            <fieldset className="rounded-xl border border-line bg-white shadow-card/60 p-3.5">
              <legend className="px-1 text-xs font-semibold text-ink">
                Permissions
              </legend>
              <p className="text-[11px] leading-relaxed text-ink-3">
                The envelope the AI may act inside when a conversation belongs
                to this agent. High-risk actions always wait for your approval,
                whatever is allowed here.
              </p>
              <div className="mt-3">
                <span className="mb-1 block text-xs font-medium text-ink-3">
                  Actions this agent may trigger
                </span>
                <div className="flex flex-wrap gap-3 text-xs text-ink-2">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="agent_actions_mode"
                      checked={allowAll}
                      onChange={() => setAllowAll(true)}
                    />
                    All actions
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="agent_actions_mode"
                      checked={!allowAll}
                      onChange={() => setAllowAll(false)}
                    />
                    Only selected
                  </label>
                </div>
                {!allowAll ? (
                  <div className="mt-2 grid max-h-44 gap-1 overflow-y-auto rounded-lg border border-line bg-white p-2 sm:grid-cols-2">
                    {catalog.length === 0 ? (
                      <p className="text-[11px] text-ink-3">
                        Action catalog unavailable right now.
                      </p>
                    ) : (
                      catalog.map((item) => (
                        <label
                          key={item.action}
                          className="flex items-start gap-1.5 text-[11px] text-ink-2"
                          title={item.description}
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={allowedActions.includes(item.action)}
                            onChange={() => toggleAction(item.action)}
                          />
                          <span className="min-w-0">
                            <span className="font-medium text-ink">
                              {item.action}
                            </span>{" "}
                            <span className="text-ink-3">({item.risk})</span>
                          </span>
                        </label>
                      ))
                    )}
                  </div>
                ) : null}
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="agent_max_risk"
                    className="mb-1 block text-xs font-medium text-ink-3"
                  >
                    Highest action risk it may trigger
                  </label>
                  <select
                    id="agent_max_risk"
                    value={maxRisk}
                    onChange={(event) => setMaxRisk(event.target.value as Risk)}
                    className={inputClass}
                  >
                    {(Object.keys(RISK_LABEL) as Risk[]).map((level) => (
                      <option key={level} value={level}>
                        {RISK_LABEL[level]}
                      </option>
                    ))}
                  </select>
                </div>
                <label className="flex items-start gap-2 pt-6 text-xs text-ink-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={canAutoReply}
                    onChange={(event) => setCanAutoReply(event.target.checked)}
                  />
                  <span>
                    May send replies automatically
                    <span className="block text-[11px] text-ink-3">
                      Unchecked = drafts only, even when the Business Brain
                      runs in Auto.
                    </span>
                  </span>
                </label>
              </div>
            </fieldset>


            <fieldset className="rounded-xl border border-line bg-white shadow-card/60 p-3.5">
              <legend className="px-1 text-xs font-semibold text-ink">
                Active hours
              </legend>
              <p className="text-[11px] leading-relaxed text-ink-3">
                Optional weekly windows for this persona. Off means the agent
                can auto-reply any time. Outside the window the brain drafts
                only (same as turning auto-reply off).
              </p>
              <label className="mt-3 flex items-start gap-2 text-xs text-ink-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={schedule.enabled}
                  onChange={(event) =>
                    setSchedule((prev) => ({
                      ...prev,
                      enabled: event.target.checked,
                    }))
                  }
                />
                <span>
                  Limit auto-reply to the hours below
                  <span className="block text-[11px] text-ink-3">
                    Timezone: {schedule.timezone}
                  </span>
                </span>
              </label>
              {schedule.enabled ? (
                <div className="mt-3 space-y-2">
                  <label className="block text-xs text-ink-2">
                    <span className="mb-1 block text-ink-3">Timezone</span>
                    <input
                      type="text"
                      value={schedule.timezone}
                      onChange={(event) =>
                        setSchedule((prev) => ({
                          ...prev,
                          timezone: event.target.value.slice(0, 64),
                        }))
                      }
                      placeholder="Asia/Karachi"
                      className={inputClass}
                    />
                  </label>
                  <div className="grid gap-2">
                    {SCHEDULE_DAY_LABELS.map((label, index) => {
                      const day = schedule.days[index];
                      return (
                        <div
                          key={label}
                          className="flex flex-wrap items-center gap-2 text-xs text-ink-2"
                        >
                          <label className="flex w-14 items-center gap-1.5">
                            <input
                              type="checkbox"
                              checked={day.enabled}
                              onChange={(event) =>
                                setSchedule((prev) => {
                                  const days = prev.days.map((d, i) =>
                                    i === index
                                      ? { ...d, enabled: event.target.checked }
                                      : d
                                  );
                                  return { ...prev, days };
                                })
                              }
                            />
                            {label}
                          </label>
                          <input
                            type="time"
                            value={day.start}
                            disabled={!day.enabled}
                            onChange={(event) =>
                              setSchedule((prev) => {
                                const days = prev.days.map((d, i) =>
                                  i === index
                                    ? { ...d, start: event.target.value || d.start }
                                    : d
                                );
                                return { ...prev, days };
                              })
                            }
                            className="rounded-lg border border-line bg-soft px-2 py-1 text-xs text-ink outline-none disabled:opacity-40"
                          />
                          <span className="text-ink-3">to</span>
                          <input
                            type="time"
                            value={day.end}
                            disabled={!day.enabled}
                            onChange={(event) =>
                              setSchedule((prev) => {
                                const days = prev.days.map((d, i) =>
                                  i === index
                                    ? { ...d, end: event.target.value || d.end }
                                    : d
                                );
                                return { ...prev, days };
                              })
                            }
                            className="rounded-lg border border-line bg-soft px-2 py-1 text-xs text-ink outline-none disabled:opacity-40"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </fieldset>

            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={!name.trim() || saving}
                className={primaryBtn}
              >
                {saving
                  ? "Saving…"
                  : editingId
                  ? "Save changes"
                  : "Create agent"}
              </button>
              {editingId ? (
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="rounded-xl border border-line bg-white shadow-card px-4 py-2 text-xs text-ink-2"
                >
                  Cancel
                </button>
              ) : null}
            </div>
          </form>

          {agents !== null && agents.length === 0 ? (
            <p className="mt-4 text-xs text-ink-3">
              No agents yet. Create one above to route chats to it.
            </p>
          ) : null}
          <ul className="mt-4 space-y-2">
            {(agents ?? []).map((agent) => (
              <li
                key={agent.id}
                className="flex items-start justify-between gap-3 rounded-xl border border-line bg-white shadow-card px-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">
                      {agent.name}
                    </span>
                    <StatusChip active={agent.isActive} />
                  </div>
                  {agent.tone ? (
                    <p className="mt-0.5 truncate text-xs text-ink-2">
                      {agent.tone}
                    </p>
                  ) : null}
                  <p className="mt-0.5 text-[11px] text-ink-3">
                    {agent.versions} version{agent.versions === 1 ? "" : "s"}
                    {agent.escalationUserId != null
                      ? " · escalates to user " + agent.escalationUserId
                      : ""}
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-3">
                    {permissionSummary(agent)}
                    {agent.schedule?.enabled && !agent.inHours ? (
                      <span className="ml-1 rounded-full border border-amber-400/30 bg-amber-400/[0.08] px-1.5 py-0.5 text-[10px] text-amber-700">
                        Outside hours
                      </span>
                    ) : null}
                  </p>
                  {versionsFor === agent.id ? (
                    <div className="mt-2 rounded-lg border border-line bg-white p-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                          Version history
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setVersionsFor(null);
                            setVersions(null);
                          }}
                          className="text-[11px] text-ink-3 hover:text-ink"
                        >
                          Close
                        </button>
                      </div>
                      {versions === null ? (
                        <p className="mt-1.5 text-[11px] text-ink-3">
                          Loading history…
                        </p>
                      ) : versions.length === 0 ? (
                        <p className="mt-1.5 text-[11px] text-ink-3">
                          No versions recorded yet.
                        </p>
                      ) : (
                        <ul className="mt-1.5 space-y-1">
                          {versions.map((entry, index) => (
                            <li
                              key={entry.version}
                              className="flex items-start justify-between gap-2 text-[11px]"
                            >
                              <span className="min-w-0 text-ink-2">
                                <span className="font-medium text-ink">
                                  v{entry.version}
                                </span>
                                {index === 0 ? " (current)" : ""}
                                {entry.note ? " · " + entry.note : ""}
                                {entry.createdAt
                                  ? " · " + formatWhen(entry.createdAt)
                                  : ""}
                                <span className="block truncate text-ink-3">
                                  {entry.snapshot.name}
                                  {entry.snapshot.tone
                                    ? " · " + entry.snapshot.tone
                                    : ""}
                                  {" · max risk " + entry.snapshot.maxRisk}
                                  {entry.snapshot.canAutoReply
                                    ? ""
                                    : " · drafts only"}
                                </span>
                              </span>
                              {index === 0 ? null : (
                                <button
                                  type="button"
                                  disabled={restoring !== null}
                                  onClick={() =>
                                    void restoreVersion(agent.id, entry.version)
                                  }
                                  className="shrink-0 rounded-md border border-line bg-soft px-2 py-0.5 text-[11px] text-ink-2 disabled:opacity-50"
                                >
                                  {restoring === entry.version
                                    ? "Restoring…"
                                    : "Restore"}
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    onClick={() => startEdit(agent)}
                    className="rounded-lg border border-line bg-white px-2.5 py-1 text-xs text-ink-2"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => void toggleVersions(agent.id)}
                    className="rounded-lg border border-line bg-white px-2.5 py-1 text-xs text-ink-2"
                  >
                    Versions
                  </button>
                  <button
                    onClick={() => void archive(agent.id)}
                    className="rounded-lg border border-line bg-white px-2.5 py-1 text-xs text-danger"
                  >
                    Archive
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* ---------- Routing rules ---------- */}
        <div className="rounded-2xl border border-line bg-white p-5">
          <h3 className="text-sm font-semibold text-ink">Routing rules</h3>
          <p className="mt-1 text-xs text-ink-3">
            First matching keyword (lowest priority first) assigns the
            conversation to a teammate or an active agent.
          </p>

          <form onSubmit={addRule} className="mt-4 space-y-3">
            <div>
              <label
                htmlFor="rule_match"
                className="mb-1 block text-xs font-medium text-ink-3"
              >
                When message contains
              </label>
              <input
                id="rule_match"
                value={match}
                onChange={(event) => setMatch(event.target.value)}
                placeholder="e.g. refund"
                maxLength={60}
                className={inputClass}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="rule_target"
                  className="mb-1 block text-xs font-medium text-ink-3"
                >
                  Assign to
                </label>
                <select
                  id="rule_target"
                  value={targetType}
                  onChange={(event) =>
                    setTargetType(
                      event.target.value === "agent" ? "agent" : "user"
                    )
                  }
                  className={inputClass}
                >
                  <option value="user">Teammate</option>
                  <option value="agent">AI agent</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor="rule_priority"
                  className="mb-1 block text-xs font-medium text-ink-3"
                >
                  Priority
                </label>
                <input
                  id="rule_priority"
                  value={priority}
                  onChange={(event) => setPriority(event.target.value)}
                  inputMode="numeric"
                  className={inputClass}
                />
              </div>
            </div>
            {targetType === "user" ? (
              <div>
                <label
                  htmlFor="rule_user"
                  className="mb-1 block text-xs font-medium text-ink-3"
                >
                  Teammate user id
                </label>
                <input
                  id="rule_user"
                  value={userId}
                  onChange={(event) => setUserId(event.target.value)}
                  inputMode="numeric"
                  className={inputClass}
                />
                {members.length > 0 ? (
                  <p className="mt-1 text-[11px] text-ink-3">
                    Team:{" "}
                    {members
                      .map((member) => member.name + " (id " + member.id + ")")
                      .join(", ")}
                  </p>
                ) : null}
              </div>
            ) : (
              <div>
                <label
                  htmlFor="rule_agent"
                  className="mb-1 block text-xs font-medium text-ink-3"
                >
                  AI agent
                </label>
                <select
                  id="rule_agent"
                  value={agentId}
                  onChange={(event) => setAgentId(event.target.value)}
                  className={inputClass}
                >
                  <option value="">Select an active agent…</option>
                  {activeAgents.map((agent) => (
                    <option key={agent.id} value={String(agent.id)}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <button
              type="submit"
              disabled={
                !match.trim() ||
                (targetType === "user" && !userId.trim()) ||
                (targetType === "agent" && !agentId.trim()) ||
                addingRule
              }
              className={primaryBtn}
            >
              {addingRule ? "Adding…" : "Add rule"}
            </button>
          </form>

          {rules !== null && rules.length === 0 ? (
            <p className="mt-4 text-xs text-ink-3">
              No rules yet. Add one above to start routing automatically.
            </p>
          ) : null}
          <ul className="mt-4 space-y-1.5">
            {(rules ?? []).map((rule) => (
              <li
                key={rule.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-line bg-white shadow-card px-3 py-2"
              >
                <span className="min-w-0 truncate text-xs text-ink">
                  “{rule.match}” →{" "}
                  {rule.targetType === "agent"
                    ? "agent " + (rule.agentName ?? rule.agentId ?? "")
                    : "user " + rule.userId}{" "}
                  <span className="text-ink-3">
                    (priority {rule.priority})
                  </span>
                </span>
                <button
                  onClick={() => void removeRule(rule)}
                  className="shrink-0 rounded-lg border border-line bg-white px-2.5 py-1 text-xs text-danger"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
