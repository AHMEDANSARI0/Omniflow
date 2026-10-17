/**
 * OmniFlow Control Plane client. Every mobile screen reaches the existing
 * CP through this single typed wrapper - no direct DB access, no second
 * backend. Design goals: extremely fast (in-flight GET dedupe, sane
 * timeouts, bounded retries with jitter) and fail-soft everywhere.
 */

import { apiUrl, appVariant, appVersion } from "@/config/env";
import { logger } from "@/lib/logger";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export interface RequestOptions {
  /** ms before the request is aborted (default 15000) */
  timeoutMs?: number;
  /** attach the bearer token (default true for /api/v1/portal routes) */
  auth?: boolean;
  /** extra headers */
  headers?: Record<string, string>;
  /** override retries for idempotent requests (default: 2 for GET) */
  retries?: number;
  signal?: AbortSignal;
}

export type TokenProvider = () => Promise<{
  access: string | null;
  /** attempt one refresh; return the new access token or null */
  refresh: () => Promise<string | null>;
}>;

let tokenProvider: TokenProvider | null = null;

export function setTokenProvider(provider: TokenProvider | null): void {
  tokenProvider = provider;
}

const inflight = new Map<string, Promise<unknown>>();

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms: number): number {
  return ms + Math.floor(Math.random() * 120);
}

async function rawRequest<T>(
  method: string,
  path: string,
  body: unknown,
  opts: RequestOptions,
  accessToken: string | null,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? 15_000,
  );
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onOuterAbort);

  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Omniflow-Mobile": appVersion,
    "X-Omniflow-App": appVariant,
    ...(opts.headers ?? {}),
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  try {
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let message = res.statusText || `HTTP ${res.status}`;
      let code = `http_${res.status}`;
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object") {
          const obj = parsed as Record<string, unknown>;
          if (typeof obj.error === "string") message = obj.error;
          if (typeof obj.message === "string") message = obj.message;
          if (typeof obj.code === "string") code = obj.code;
        }
      } catch {
        // non-JSON error body: keep the status text
      }
      throw new ApiError(res.status, code, message, RETRY_STATUSES.has(res.status));
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined as T;
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const aborted =
      (err instanceof Error && err.name === "AbortError") ||
      opts.signal?.aborted === true;
    throw new ApiError(
      aborted ? 0 : 599,
      aborted ? "aborted" : "network",
      aborted ? "Request cancelled" : "Network unavailable",
      !aborted,
    );
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

async function requestWithAuth<T>(
  method: string,
  path: string,
  body: unknown,
  opts: RequestOptions,
): Promise<T> {
  const needsAuth = opts.auth !== false && path.includes("/api/v1/");
  const provider = needsAuth ? tokenProvider : null;
  const initial = provider ? await provider() : null;

  try {
    return await rawRequest<T>(method, path, body, opts, initial?.access ?? null);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && provider && initial) {
      const refreshed = await initial.refresh().catch(() => null);
      if (refreshed) {
        return rawRequest<T>(method, path, body, { ...opts, retries: 0 }, refreshed);
      }
    }
    throw err;
  }
}

async function request<T>(
  method: string,
  path: string,
  body: unknown,
  opts: RequestOptions,
): Promise<T> {
  const retries = opts.retries ?? (method === "GET" ? 2 : 0);
  let attempt = 0;
  for (;;) {
    try {
      return await requestWithAuth<T>(method, path, body, opts);
    } catch (err) {
      attempt += 1;
      const retryable = err instanceof ApiError && err.retryable;
      if (!retryable || attempt > retries) throw err;
      await sleep(jitter(300 * attempt));
    }
  }
}

function dedupedGet<T>(path: string, opts: RequestOptions): Promise<T> {
  const existing = inflight.get(path);
  if (existing) return existing as Promise<T>;
  const p = request<T>("GET", path, undefined, opts).finally(() =>
    inflight.delete(path),
  );
  inflight.set(path, p);
  return p;
}

export const api = {
  get<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return dedupedGet<T>(path, opts);
  },
  post<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return request<T>("POST", path, body, opts);
  },
  // §278: PUT for the portal profile document (workflows status uses POST).
  put<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return request<T>("PUT", path, body, opts);
  },
  patch<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return request<T>("PATCH", path, body, opts);
  },
  delete<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return request<T>("DELETE", path, undefined, opts);
  },
  /** Exposed for tests and diagnostics (Home health card). */
  _inflightCount(): number {
    return inflight.size;
  },
};

export { logger as apiLogger };
