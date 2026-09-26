/**
 * The OmniFlow wordmark: a gradient flow glyph (message becoming a
 * workflow) plus the name. Used by the navbar, footer and auth pages.
 */
export default function Logo({
  dark = false,
  size = "md",
}: {
  dark?: boolean;
  size?: "sm" | "md";
}) {
  const box = size === "sm" ? "h-7 w-7 rounded-[9px]" : "h-8 w-8 rounded-[10px]";
  const text =
    size === "sm"
      ? "text-[15px]"
      : "text-[17px]";
  return (
    <span className="inline-flex items-center gap-2.5">
      <span
        aria-hidden
        className={`of-gradient relative inline-flex ${box} items-center justify-center shadow-[0_4px_12px_-4px_rgba(79,70,229,0.55)]`}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          className={size === "sm" ? "h-4 w-4" : "h-[18px] w-[18px]"}
        >
          <path
            d="M4 7.5C4 5.6 5.6 4 7.5 4h6.2c1.9 0 3.5 1.6 3.5 3.5v3.2c0 1.9-1.6 3.5-3.5 3.5H9.8L6.6 17v-2.9C5.1 13.7 4 12.4 4 10.8V7.5Z"
            fill="rgba(255,255,255,0.92)"
          />
          <circle cx="17.2" cy="17.2" r="2.3" fill="rgba(255,255,255,0.95)" />
          <path
            d="M12.6 15.4l2.6 1.8"
            stroke="rgba(255,255,255,0.9)"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <span
        className={`${text} font-display font-semibold tracking-[-0.02em] ${
          dark ? "text-snow" : "text-ink"
        }`}
      >
        Omni<span className={dark ? "text-indigo-300" : "text-brand"}>Flow</span>
      </span>
    </span>
  );
}
