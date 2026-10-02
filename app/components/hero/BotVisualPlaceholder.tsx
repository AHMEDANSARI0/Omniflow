import { getCopy } from "../../../lib/marketing/cms";

/**
 * Lightweight stand-in for the future 3D AI bot: a calm "AI core"
 * (gradient ring + OmniFlow mark) on soft concentric rings. CSS and
 * inline SVG only, no images.
 */
export default async function BotVisualPlaceholder() {
  const hero = (await getCopy("home_sections")).hero;
  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <div
        aria-hidden
        className="absolute inset-[-18%] rounded-full bg-[radial-gradient(circle,rgba(99,91,255,0.16),rgba(14,165,233,0.06)_45%,transparent_70%)]"
      />
      <div aria-hidden className="absolute inset-[-6%] rounded-full border border-brand/10" />
      <div aria-hidden className="absolute inset-[8%] rounded-full border border-dashed border-brand/20" />
      <div aria-hidden className="absolute inset-[22%] rounded-full border border-brand/15 bg-white/40" />

      <div className="relative flex flex-col items-center">
        <div className="of-ring-gradient flex h-28 w-28 items-center justify-center rounded-full shadow-[0_24px_60px_-24px_rgba(99,91,255,0.55)] sm:h-32 sm:w-32">
          <span className="of-gradient flex h-16 w-16 items-center justify-center rounded-2xl shadow-[0_10px_24px_-10px_rgba(99,91,255,0.7)] sm:h-[72px] sm:w-[72px]">
            <svg viewBox="0 0 24 24" fill="none" className="h-9 w-9" aria-hidden>
              <path
                d="M4 7.5C4 5.6 5.6 4 7.5 4h6.2c1.9 0 3.5 1.6 3.5 3.5v3.2c0 1.9-1.6 3.5-3.5 3.5H9.8L6.6 17v-2.9C5.1 13.7 4 12.4 4 10.8V7.5Z"
                fill="rgba(255,255,255,0.94)"
              />
              <circle cx="17.2" cy="17.2" r="2.3" fill="rgba(255,255,255,0.96)" />
              <path d="M12.6 15.4l2.6 1.8" stroke="rgba(255,255,255,0.9)" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </span>
        </div>
        <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-line bg-white px-3 py-1 text-[12px] font-semibold text-ink shadow-card">
          {hero.visualLabel}
          <span className="inline-flex items-center gap-1 text-ok">
            <span aria-hidden className="of-pulse h-1.5 w-1.5 rounded-full bg-success" />
            {hero.visualStatus}
          </span>
        </p>
      </div>
    </div>
  );
}
