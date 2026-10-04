import ModelRouterClient from "./ModelRouterClient";

// Admin -> Model Router (§229). The panel layout already enforces the
// admin session and role.
export default function ModelRouterPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Model Router</h1>
        <p className="mt-1.5 text-sm text-ink-3">
          Choose which model answers which AI task, and keep AI running when a provider is down.
        </p>
      </div>
      <ModelRouterClient />
    </div>
  );
}
