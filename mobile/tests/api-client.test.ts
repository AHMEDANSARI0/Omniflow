/**
 * Api client behavior on a mocked fetch: error normalization, GET retry
 * with backoff, in-flight dedupe, and 401-refresh-then-retry.
 */

import { ApiError, api, setTokenProvider } from "@/api/client";

type FetchArgs = { url: string; init?: RequestInit };

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("api client", () => {
  const calls: FetchArgs[] = [];
  let handler: (url: string) => Response | Promise<Response>;

  beforeEach(() => {
    calls.length = 0;
    setTokenProvider(null);
    handler = () => jsonResponse(200, { ok: true });
    (globalThis as { fetch?: unknown }).fetch = async (
      url: string,
      init?: RequestInit,
    ) => {
      calls.push({ url, init });
      return handler(url);
    };
  });

  afterAll(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  it("parses JSON success responses", async () => {
    const data = await api.get<{ ok: boolean }>("/api/v1/anything", {
      auth: false,
      retries: 0,
    });
    expect(data.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("normalizes HTTP errors into ApiError", async () => {
    handler = () => jsonResponse(422, { error: "bad input" });
    await expect(
      api.get("/api/v1/x", { auth: false, retries: 0 }),
    ).rejects.toMatchObject({ status: 422, message: "bad input", retryable: false });
  });

  it("retries idempotent GETs on retryable statuses then succeeds", async () => {
    let n = 0;
    handler = () => {
      n += 1;
      return n < 3 ? jsonResponse(503, {}) : jsonResponse(200, { done: true });
    };
    const data = await api.get<{ done: boolean }>("/api/v1/flaky", {
      auth: false,
    });
    expect(data.done).toBe(true);
    expect(n).toBe(3);
  });

  it("stops after the retry budget and throws the last error", async () => {
    handler = () => jsonResponse(500, {});
    await expect(
      api.get("/api/v1/dead", { auth: false, retries: 2 }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(3); // 1 attempt + 2 retries
  });

  it("dedupes concurrent identical GETs", async () => {
    let resolveFn!: (r: Response) => void;
    const pending = new Promise<Response>((r) => {
      resolveFn = r;
    });
    handler = () => pending;
    const p1 = api.get("/api/v1/slow", { auth: false });
    const p2 = api.get("/api/v1/slow", { auth: false });
    expect(api._inflightCount()).toBe(1);
    resolveFn(jsonResponse(200, { v: 1 }));
    await Promise.all([p1, p2]);
    expect(calls).toHaveLength(1);
  });

  it("refreshes once on 401 then retries the original request", async () => {
    setTokenProvider(async () => ({ access: "stale", refresh: async () => "fresh" }));
    let seen: string[] = [];
    handler = (url) => {
      const auth = calls[calls.length - 1]?.init?.headers as Record<string, string>;
      seen.push(auth.Authorization ?? "");
      return seen.length === 1
        ? jsonResponse(401, {})
        : jsonResponse(200, { authed: true });
    };
    const data = await api.get<{ authed: boolean }>("/api/v1/protected", {
      retries: 0,
    });
    expect(data.authed).toBe(true);
    expect(seen).toEqual(["Bearer stale", "Bearer fresh"]);
  });
});
