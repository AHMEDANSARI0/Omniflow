"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  CircleDollarSign,
  Clock,
  MessageCircle,
  Package,
  ScanSearch,
  Send,
  Sparkles,
  Store,
  UserRound,
  GitBranch,
} from "lucide-react";

/**
 * The hero's live automation run: a WhatsApp message becomes an AI
 * decision and real actions, step by step, on a loop. Reduced-motion
 * users see the finished run instead of the animation.
 */

type Status = "idle" | "running" | "done";

type Step = {
  key: string;
  icon: typeof Sparkles;
  title: string;
  detail?: string;
  tone?: "brand" | "ai" | "flow" | "ok";
};

const CONTEXT_CHIPS = [
  { label: "Product", Icon: Package },
  { label: "Availability", Icon: Store },
  { label: "Price", Icon: CircleDollarSign },
  { label: "Delivery policy", Icon: Clock },
  { label: "Customer history", Icon: UserRound },
];

const ACTIONS = [
  { label: "Send product information", Icon: MessageCircle },
  { label: "Send order link", Icon: Send },
  { label: "Schedule follow-up", Icon: Clock },
];

const RESULTS = [
  "Response sent",
  "Customer qualified",
  "Follow-up scheduled",
];

const STEP_MS = 1350;
const HOLD_MS = 3000;

export default function WorkflowAnimation() {
  const [step, setStep] = useState(0); // 0 message, 1 ai, 2 context, 3 intent, 4 decision, 5 actions, 6 results
  const [reduced, setReduced] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(media.matches);
    const onChange = () => setReduced(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (reduced) {
      setStep(6);
      return;
    }
    if (step >= 6) {
      timer.current = setTimeout(() => setStep(0), HOLD_MS);
    } else {
      timer.current = setTimeout(() => setStep((value) => value + 1), STEP_MS);
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [step, reduced]);

  const statusFor = (index: number): Status => {
    if (reduced) return "done";
    if (index < step) return "done";
    if (index === step) return "running";
    return "idle";
  };

  return (
    <div className="relative w-full max-w-[460px]">
      {/* ambient glow */}
      <div
        aria-hidden
        className="of-hero-glow pointer-events-none absolute -inset-10 -z-10"
      />

      <div className="rounded-xl3 border border-line bg-white shadow-card-hover">
        {/* product header */}
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="of-gradient inline-flex h-6 w-6 items-center justify-center rounded-lg"
            >
              <Sparkles className="h-3.5 w-3.5 text-white" />
            </span>
            <p className="text-[13px] font-semibold text-ink">OmniFlow AI</p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-ok/20 bg-ok-soft px-2 py-0.5 text-[11px] font-medium text-ok">
            <span aria-hidden className="of-pulse h-1.5 w-1.5 rounded-full bg-ok" />
            Active
          </span>
        </div>

        <div className="space-y-3.5 px-5 py-5">
          {/* step 0 — the incoming WhatsApp message */}
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-3">
              WhatsApp · Incoming message
            </p>
            <div
              className={`mt-2 inline-flex max-w-full items-start gap-2 rounded-xl2 rounded-tl-md border px-3.5 py-2.5 transition-all duration-500 ${
                statusFor(0) === "idle"
                  ? "border-line bg-soft text-ink-3"
                  : "border-[#bbf7d0] bg-[#f0fdf4] text-ink"
              }`}
            >
              <MessageCircle
                className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${statusFor(0) === "idle" ? "text-ink-3" : "text-ok"}`}
                aria-hidden
              />
              <p className="text-[13px] leading-snug">
                Assalam o Alaikum, mujhe black hoodie medium size mein
                chahiye. Price aur delivery bata dein?
              </p>
            </div>
          </div>

          <Rail status={statusFor(1)} />

          {/* step 1 — AI understanding */}
          <StepRow
            status={statusFor(1)}
            icon={<ScanSearch className="h-4 w-4" aria-hidden />}
            title="OmniFlow AI"
            detail={
              statusFor(1) === "running"
                ? "Understanding the conversation…"
                : statusFor(1) === "done"
                  ? "Message understood"
                  : "Waiting"
            }
            tone="ai"
          />

          <Rail status={statusFor(2)} />

          {/* step 2 — context */}
          <div>
            <div className="flex items-center gap-2">
              <StepIcon
                status={statusFor(2)}
                icon={<Sparkles className="h-4 w-4" aria-hidden />}
              />
              <p
                className={`text-[13px] font-medium ${
                  statusFor(2) === "idle" ? "text-ink-3" : "text-ink"
                }`}
              >
                Context applied
              </p>
              <StepPill status={statusFor(2)} />
            </div>
            <div
              className={`mt-2 flex flex-wrap gap-1.5 pl-8 transition-opacity duration-500 ${
                statusFor(2) === "idle" ? "opacity-35" : "opacity-100"
              }`}
            >
              {CONTEXT_CHIPS.map(({ label, Icon }) => (
                <span
                  key={label}
                  className="inline-flex items-center gap-1 rounded-full border border-line bg-soft px-2 py-1 text-[11px] font-medium text-ink-2"
                >
                  <Icon className="h-3 w-3 text-brand" aria-hidden />
                  {label}
                </span>
              ))}
            </div>
          </div>

          <Rail status={statusFor(3)} />

          {/* step 3 — intent */}
          <StepRow
            status={statusFor(3)}
            icon={<GitBranch className="h-4 w-4" aria-hidden />}
            title="Intent detected"
            detail="Product inquiry · High purchase intent"
            tone="brand"
          />

          <Rail status={statusFor(4)} />

          {/* step 4 — decision */}
          <StepRow
            status={statusFor(4)}
            icon={<GitBranch className="h-4 w-4" aria-hidden />}
            title="Workflow decision"
            detail="Product available? — YES"
            tone="flow"
          />

          <Rail status={statusFor(5)} />

          {/* step 5 — actions */}
          <div>
            <div className="flex items-center gap-2">
              <StepIcon
                status={statusFor(5)}
                icon={<ArrowRight className="h-4 w-4" aria-hidden />}
              />
              <p
                className={`text-[13px] font-medium ${
                  statusFor(5) === "idle" ? "text-ink-3" : "text-ink"
                }`}
              >
                Automation runs
              </p>
              <StepPill status={statusFor(5)} />
            </div>
            <div
              className={`mt-2 space-y-1.5 pl-8 transition-opacity duration-500 ${
                statusFor(5) === "idle" ? "opacity-35" : "opacity-100"
              }`}
            >
              {ACTIONS.map(({ label, Icon }) => (
                <p
                  key={label}
                  className="flex items-center gap-2 text-[12.5px] font-medium text-ink-2"
                >
                  <Icon className="h-3.5 w-3.5 text-brand" aria-hidden />
                  {label}
                </p>
              ))}
            </div>
          </div>

          <Rail status={statusFor(6)} />

          {/* step 6 — results */}
          <div
            className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl2 border px-4 py-3 transition-all duration-500 ${
              statusFor(6) === "done"
                ? "border-ok/25 bg-ok-soft"
                : "border-line bg-soft opacity-50"
            }`}
          >
            {RESULTS.map((label) => (
              <span
                key={label}
                className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-ok"
              >
                <Check className="h-3.5 w-3.5" aria-hidden />
                {label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Rail({ status }: { status: Status }) {
  return (
    <div className="ml-[15px] h-3 w-px">
      <div
        className={`h-full w-px ${
          status === "idle" ? "bg-line" : "bg-gradient-to-b from-brand to-ai"
        }`}
      />
    </div>
  );
}

function StepIcon({
  status,
  icon,
}: {
  status: Status;
  icon: React.ReactNode;
}) {
  return (
    <span
      aria-hidden
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors duration-500 ${
        status === "done"
          ? "border-ok/25 bg-ok-soft text-ok"
          : status === "running"
            ? "of-borderpulse border-ai/30 bg-ai-soft text-ai"
            : "border-line bg-white text-ink-3"
      }`}
    >
      {status === "done" ? <Check className="h-4 w-4" /> : icon}
    </span>
  );
}

function StepPill({ status }: { status: Status }) {
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-ai/20 bg-ai-soft px-2 py-0.5 text-[11px] font-medium text-ai">
        <span
          aria-hidden
          className="of-pulse h-1.5 w-1.5 rounded-full bg-ai"
        />
        Running
      </span>
    );
  }
  if (status === "done") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-ok/20 bg-ok-soft px-2 py-0.5 text-[11px] font-medium text-ok">
        <Check className="h-3 w-3" aria-hidden />
        Done
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-line bg-white px-2 py-0.5 text-[11px] font-medium text-ink-3">
      Queued
    </span>
  );
}

function StepRow({
  status,
  icon,
  title,
  detail,
  tone,
}: {
  status: Status;
  icon: React.ReactNode;
  title: string;
  detail: string;
  tone?: "brand" | "ai" | "flow" | "ok";
}) {
  return (
    <div className="flex items-center gap-3">
      <StepIcon status={status} icon={icon} />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p
            className={`text-[13px] font-medium ${
              status === "idle" ? "text-ink-3" : "text-ink"
            }`}
          >
            {title}
          </p>
          <StepPill status={status} />
        </div>
        {detail ? (
          <p
            className={`mt-0.5 truncate text-[12px] ${
              status === "idle" ? "text-ink-3/70" : "text-ink-2"
            }`}
          >
            {detail}
          </p>
        ) : null}
      </div>
      {tone && status === "running" ? (
        <span
          aria-hidden
          className="of-pulse ml-auto h-2 w-2 shrink-0 rounded-full bg-ai"
        />
      ) : null}
    </div>
  );
}
