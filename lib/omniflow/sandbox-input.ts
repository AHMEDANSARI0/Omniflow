import type {
  SandboxChannel,
  SandboxExpectHandler,
  SandboxInput,
  SandboxScenarioInput,
  SandboxTurn,
} from "./portal";

// §230: shape the browser body for the control plane (which validates it
// fully); only known fields with the right types pass through.

const CHANNELS: SandboxChannel[] = [
  "whatsapp",
  "instagram",
  "messenger",
  "instagram_comment",
  "facebook_comment",
];

const HANDLERS: SandboxExpectHandler[] = [
  "", "any_reply", "no_reply", "brain", "kb", "away", "cod", "handoff",
];

const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.slice(0, max) : "";

export function sandboxInput(body: Record<string, unknown>): SandboxInput | null {
  const message = text(body.message, 2000).trim();
  const channel = CHANNELS.find((c) => c === body.channel);
  if (!message || !channel) return null;
  const history: SandboxTurn[] = Array.isArray(body.history)
    ? body.history.slice(0, 40).flatMap((turn: unknown) => {
        if (!turn || typeof turn !== "object") return [];
        const { role, text: said } = turn as { role?: unknown; text?: unknown };
        return (role === "customer" || role === "business") && typeof said === "string"
          ? [{ role, text: said.slice(0, 2000) }]
          : [];
      })
    : [];
  return {
    message,
    channel,
    customer_name: text(body.customer_name, 80),
    history,
    force_auto: body.force_auto === true,
    simulate_workflows: body.simulate_workflows !== false,
  };
}

export function sandboxScenarioInput(body: Record<string, unknown>): SandboxScenarioInput | null {
  const input = sandboxInput(body);
  const name = text(body.name, 80).trim();
  const handler = HANDLERS.find((h) => h === body.expect_handler) ?? "";
  if (!input || !name) return null;
  return {
    ...input,
    name,
    expect_handler: handler,
    expect_contains: text(body.expect_contains, 200),
    expect_absent: text(body.expect_absent, 200),
  };
}
