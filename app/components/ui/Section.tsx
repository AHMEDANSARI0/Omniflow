import type { ReactNode } from "react";
import Container from "./Container";

type Tone = "white" | "canvas" | "soft" | "night" | "gradient";

const TONES: Record<Tone, string> = {
  white: "bg-white",
  canvas: "bg-canvas",
  soft: "bg-soft",
  night: "bg-night text-snow of-night-glow",
  gradient: "of-cta-gradient text-white",
};

/**
 * Vertical section rhythm + background tone. The heading trio
 * (eyebrow / title / copy) keeps every section telling its story
 * the same way.
 */
export default function Section({
  children,
  id,
  tone = "white",
  className = "",
  containerClassName = "",
  wide = false,
}: {
  children: ReactNode;
  id?: string;
  tone?: Tone;
  className?: string;
  containerClassName?: string;
  wide?: boolean;
}) {
  return (
    <section id={id} className={`relative ${TONES[tone]} ${className}`}>
      <Container
        wide={wide}
        className={`py-20 sm:py-24 lg:py-28 ${containerClassName}`}
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
}: {
  eyebrow?: string;
  title: ReactNode;
  copy?: ReactNode;
  align?: "center" | "left";
  dark?: boolean;
}) {
  const centered = align === "center";
  return (
    <div
      className={`${
        centered ? "mx-auto max-w-3xl text-center" : "max-w-2xl"
      }`}
    >
      {eyebrow ? (
        <p
          className={`text-[11px] font-semibold uppercase tracking-[0.18em] ${
            dark ? "text-indigo-300" : "text-brand"
          }`}
        >
          {eyebrow}
        </p>
      ) : null}
      <h2
        className={`mt-3 font-display text-[34px] font-semibold leading-[1.12] tracking-[-0.02em] sm:text-[40px] lg:text-[48px] ${
          dark ? "text-snow" : "text-ink"
        }`}
      >
        {title}
      </h2>
      {copy ? (
        <p
          className={`mt-4 text-base leading-relaxed sm:text-lg ${
            dark ? "text-night-muted" : "text-ink-2"
          }`}
        >
          {copy}
        </p>
      ) : null}
    </div>
  );
}
