"use client";


interface SessionDto {
  access_expires_at?: unknown;
}

type CurrentSession =
  | { kind: "valid"; remainingMs: number }
  | { kind: "expired" }
  | { kind: "unavailable" };

async function currentSession(): Promise<CurrentSession> {
  let response: Response;
  try {
    response = await fetch("/api/omniflow/auth/me", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  } catch {
    return { kind: "unavailable" };
  }

  if (response.status === 401) return { kind: "expired" };
  if (!response.ok) return { kind: "unavailable" };

  try {
    const payload = (await response.json()) as SessionDto;
    if (typeof payload.access_expires_at !== "string") {
      return { kind: "unavailable" };
    }
    const expiry = Date.parse(payload.access_expires_at);
    if (!Number.isFinite(expiry)) return { kind: "unavailable" };
    return { kind: "valid", remainingMs: expiry - Date.now() };
  } catch {
    return { kind: "unavailable" };
  }
}

async function rotateIfNeeded(minimumRemainingMs: number): Promise<boolean> {
  const current = await currentSession();
  if (current.kind === "unavailable") {
    throw new Error("Session service unavailable");
  }
  if (current.kind === "valid" && current.remainingMs > minimumRemainingMs) {
    return true;
  }

  let response: Response;
  try {
    response = await fetch("/api/omniflow/auth/refresh", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  } catch {
    throw new Error("Session service unavailable");
  }

  if (response.status === 401) return false;
  if (!response.ok) throw new Error("Session service unavailable");
  return true;
}

export async function refreshSessionCoordinated(
  minimumRemainingMs = 60_000
): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(
      "omniflow-session-refresh",
      { mode: "exclusive" },
      () => rotateIfNeeded(minimumRemainingMs)
    );
  }

  return rotateIfNeeded(minimumRemainingMs);
}

export async function sessionRemainingMs(): Promise<number | null> {
  const current = await currentSession();
  if (current.kind === "unavailable") {
    throw new Error("Session service unavailable");
  }
  return current.kind === "valid" ? current.remainingMs : null;
}
