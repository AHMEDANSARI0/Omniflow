import type { ReactNode } from "react";
import Container from "./Container";

type Tone = "white" | "canvas" | "soft" | "tint" | "night" | "gradient";

const TONES: Record<Tone, string> = {
  white: "bg-white",
  canvas: "bg-canvas",
  soft: "bg-soft",
  // §216: subtle brand-tinted light surface (replaces dark bands)
  tint: "of-tint-glow",
  // legacy tones, kept for compatibility; the marketing site no longer uses them
  night: "bg-night text-snow of-night-glow",
  gradient: "of-cta-gradient text-white",
};

/**
 * Vertical section rhythm + background tone. Spacing comes from the
 * --section-spacing token; the heading trio (eyebrow / title / copy)
 * keeps every section telling its story the same way.
 */
export default function Section({
  children,
  id,
  tone = "white",
  className = "",
  containerClassName = "",
  wide = false,
  labelledBy,
}: {
  children: ReactNode;
  id?: string;
  tone?: Tone;
  className?: string;
  containerClassName?: string;
  wide?: boolean;
  labelledBy?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className={`relative ${TONES[tone]} ${className}`}
    >
      <Container
        wide={wide}
        className={`py-[var(--section-spacing,6rem)] ${containerClassName}`}
      >
        {children}
      </Container>
    </section>
  );
}

export function SectionHead({
  eyebrow,
  title,
  copy,
  align = "center",
  dark = false,
  id,
  children,
}: {
  eyebrow?: string;
  title: ReactNode;
  copy?: ReactNode;
  align?: "center" | "left";
  dark?: boolean;
  id?: string;
  children?: ReactNode;
}) {
  const centered = align === "center";
  return (
    <div className={centered ? "mx-auto max-w-3xl text-center" : "max-w-2xl"}>
      {eyebrow ? (
        <p
          className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${
            dark
              ? "border-white/15 bg-white/10 text-indigo-200"
              : "border-brand/15 bg-white text-brand-2 shadow-[0_1px_2px_rgba(16,24,40,0.04)]"
          }`}
        >
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-brand" />
          {eyebrow}
        </p>
      ) : null}
      <h2
        id={id}
        className={`mt-4 text-balance font-display text-[32px] font-semibold leading-[1.1] tracking-[-0.025em] sm:text-[42px] lg:text-[50px] ${
          dark ? "text-snow" : "text-ink"
        }`}
      >
        {title}
      </h2>
      {copy ? (
        <p
          className={`mt-4 text-pretty text-base leading-relaxed sm:text-lg ${
            centered ? "mx-auto max-w-2xl" : ""
          } ${dark ? "text-night-muted" : "text-ink-2"}`}
        >
          {copy}
        </p>
      ) : null}
      {children ? <div className="mt-7">{children}</div> : null}
    </div>
  );
}

/** Title with the gradient emphasis used across the site. */
export function Emphasis({ children }: { children: ReactNode }) {
  return (
    <span className="of-gradient bg-clip-text text-transparent">{children}</span>
  );
}
