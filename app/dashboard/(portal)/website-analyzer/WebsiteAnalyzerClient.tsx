"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  SiteScanDetail,
  SiteScanList,
  SiteScanSummary,
} from "../../../../lib/omniflow/portal";
import AnalyzerReport from "./AnalyzerReport";

// §226: the scan runs in short server steps that this page drives while it
// is open - closing the tab pauses it, reopening resumes it.

const API = "/api/omniflow/portal/site-analyzer";
const ACTIVE = new Set(["crawling", "analyzing"]);
const PAGE_CHOICES = [10, 25, 50, 100];

type Call<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

async function call<T>(path: string, init?: RequestInit): Promise<Call<T>> {
  try {
    const response = await fetch(path, {
      cache: "no-store",
      ...init,
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    });
    const payload = (await response.json().catch(() => null)) as
      | (T & { error?: { message?: string } })
      | null;
    if (response.ok && payload) return { ok: true, data: payload };
    return {
      ok: false,
      status: response.status,
      message: payload?.error?.message || "Could not reach the server. Try again shortly.",
    };
  } catch {
    return { ok: false, status: 0, message: "Could not reach the server. Try again shortly." };
  }
}

function stageLabel(detail: SiteScanDetail): string {
  const { scan } = detail;
  if (scan.stage === "catalog") return "Reading your product catalog";
  if (scan.status === "analyzing") return "Building the report";
  if (scan.stage === "robots") return "Checking robots.txt and sitemap";
  return "Reading pages";
}

function when(value: string | null): string {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
}

const STATUS_STYLE: Record<string, string> = {
  done: "bg-ok-soft text-ok",
  failed: "bg-danger-soft text-danger",
  cancelled: "bg-soft text-ink-3",
  crawling: "bg-brand-soft text-brand",
  analyzing: "bg-brand-soft text-brand",
};

export default function WebsiteAnalyzerClient() {
  const [list, setList] = useState<SiteScanList | null>(null);
  const [detail, setDetail] = useState<SiteScanDetail | null>(null);
  const [url, setUrl] = useState("");
  const [pages, setPages] = useState(25);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const open = useCallback(async (scanId: number) => {
    const res = await call<SiteScanDetail>(API + "/" + scanId);
    if (res.ok) setDetail(res.data);
    else setNote(res.message);
  }, []);

  const loadList = useCallback(async (pick: boolean) => {
    const res = await call<SiteScanList>(API);
    if (!res.ok) {
      setNote(res.message);
      return;
    }
    setList(res.data);
    if (!pick) return;
    setUrl((current) => current || res.data.suggestedUrl);
    setPages(Math.min(res.data.limits.defaultPages, res.data.limits.maxPages));
    const running = res.data.scans.find((s) => ACTIVE.has(s.status));
    const latest = running ?? res.data.scans.find((s) => s.status === "done");
    if (latest) await open(latest.id);
  }, [open]);

  useEffect(() => {
    void loadList(true);
  }, [loadList]);

  const scanId = detail?.scan.id ?? 0;
  const running = detail !== null && ACTIVE.has(detail.scan.status);

  useEffect(() => {
    if (!running) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const res = await call<SiteScanDetail>(API + "/" + scanId + "/step", {
        method: "POST",
        body: "{}",
      });
      if (stopped) return;
      if (!res.ok) {
        if (res.status === 404) {
          setDetail(null);
          return;
        }
        setNote(res.message);
        timer = setTimeout(tick, 4000);
        return;
      }
      setNote(null);
      setDetail(res.data);
      if (ACTIVE.has(res.data.scan.status)) {
        timer = setTimeout(tick, res.data.busy ? 2500 : 300);
      } else {
        void loadList(false);
      }
    };
    timer = setTimeout(tick, 300);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [running, scanId, loadList]);

  async function start() {
    setBusy(true);
    setNote(null);
    const res = await call<SiteScanDetail>(API, {
      method: "POST",
      body: JSON.stringify({ url, maxPages: pages }),
    });
    setBusy(false);
    if (res.ok) {
      setDetail(res.data);
      void loadList(false);
    } else {
      setNote(res.message);
      if (res.status === 409) void loadList(true);
    }
  }

  async function cancel() {
    if (!detail) return;
    const res = await call<SiteScanDetail>(API + "/" + detail.scan.id + "/cancel", {
      method: "POST",
      body: "{}",
    });
    if (res.ok) setDetail(res.data);
    else setNote(res.message);
    void loadList(false);
  }

  async function remove(scan: SiteScanSummary) {
    if (!window.confirm("Delete the scan of " + scan.host + "? Applied changes stay.")) return;
    const res = await call<{ ok: boolean }>(API + "/" + scan.id, { method: "DELETE" });
    if (!res.ok) {
      setNote(res.message);
      return;
    }
    if (detail?.scan.id === scan.id) setDetail(null);
    void loadList(false);
  }

  const limits = list?.limits;
  const choices = PAGE_CHOICES.filter((n) => !limits || n <= limits.maxPages);
  const scan = detail?.scan;

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-line bg-white p-5 shadow-card">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="yourstore.com"
            aria-label="Website address"
            maxLength={500}
            className="flex-1 rounded-xl border border-line bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-3 outline-none focus:border-brand/40"
          />
          <select
            value={pages}
            onChange={(event) => setPages(Number(event.target.value))}
            aria-label="Pages to read"
            className="rounded-xl border border-line bg-soft px-3 py-2 text-sm text-ink outline-none focus:border-brand/40"
          >
            {choices.map((n) => (
              <option key={n} value={n}>
                Up to {n} pages
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={busy || running || !url.trim()}
            className="rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-white transition-opacity duration-300 hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Starting..." : "Analyze"}
          </button>
        </form>
        <p className="mt-2 text-[11px] text-ink-3">
          Public pages only. robots.txt is respected; carts, accounts and checkout are skipped.
          {limits ? " " + limits.usedToday + " of " + limits.scansPerDay + " scans used today." : ""}
          {list
            ? list.aiAvailable
              ? " AI also reads the key pages; its findings are marked AI extracted."
              : " Everything shown comes straight from your pages."
            : ""}
        </p>
        {note ? <p className="mt-2 text-xs text-danger">{note}</p> : null}
      </section>

      {scan && running && detail ? (
        <section className="rounded-2xl border border-line bg-white p-5 shadow-card">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink">{scan.host}</p>
              <p className="mt-0.5 text-xs text-ink-3">
                {stageLabel(detail)} · {scan.pagesDone} of up to {scan.maxPages} pages
                {detail.busy ? " · another tab is running this step" : ""}
              </p>
            </div>
            <button
              onClick={() => void cancel()}
              className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-ink-2 hover:bg-soft"
            >
              Cancel
            </button>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-soft">
            <div
              className="h-full rounded-full bg-brand transition-all duration-500"
              style={{
                width:
                  String(
                    scan.status === "analyzing"
                      ? 95
                      : Math.min(90, Math.round((scan.pagesDone / Math.max(1, scan.maxPages)) * 90))
                  ) + "%",
              }}
            />
          </div>
          <p className="mt-2 text-[11px] text-ink-3">
            Keep this page open while it runs. If you leave, it continues when you come back.
          </p>
        </section>
      ) : null}

      {scan && scan.status === "failed" ? (
        <p className="rounded-2xl border border-line bg-white p-5 text-sm text-danger shadow-card">
          The scan of {scan.host} stopped: {scan.error || "unknown error"}
        </p>
      ) : null}
      {scan && scan.status === "cancelled" ? (
        <p className="rounded-2xl border border-line bg-white p-5 text-sm text-ink-2 shadow-card">
          The scan of {scan.host} was cancelled after {scan.pagesDone} pages.
        </p>
      ) : null}

      {scan && scan.status === "done" && scan.report && detail ? (
        <AnalyzerReport
          key={scan.id}
          scan={scan}
          report={scan.report}
          pages={detail.pages}
          canApply={detail.canApply}
          onApplied={() => void open(scan.id)}
        />
      ) : null}

      {list && list.scans.length > 0 ? (
        <section className="rounded-2xl border border-line bg-white p-5 shadow-card">
          <h3 className="text-sm font-semibold text-ink">Recent scans</h3>
          <div className="mt-3 space-y-1.5">
            {list.scans.map((row) => (
              <div
                key={row.id}
                className={
                  "flex items-center justify-between gap-2 rounded-xl border px-3 py-2 " +
                  (row.id === scan?.id ? "border-brand/40" : "border-line")
                }
              >
                <button
                  onClick={() => void open(row.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-sm text-ink">{row.host}</p>
                  <p className="text-[11px] text-ink-3">
                    {when(row.createdAt)} · {row.pagesDone} pages
                    {row.score !== null ? " · readiness " + row.score + "/100" : ""}
                  </p>
                </button>
                <span
                  className={
                    "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] " +
                    (STATUS_STYLE[row.status] ?? "bg-soft text-ink-2")
                  }
                >
                  {row.status}
                </span>
                {list.canApply && !ACTIVE.has(row.status) ? (
                  <button
                    onClick={() => void remove(row)}
                    className="shrink-0 rounded-lg border border-line px-2 py-0.5 text-[11px] text-ink-3 hover:bg-soft"
                  >
                    Delete
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
