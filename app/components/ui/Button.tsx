import type { ReactNode } from "react";

type Variant =
  | "primary" // solid indigo — the default CTA
  | "secondary" // white + border
  | "ghost" // quiet text button
  | "ai" // indigo -> violet gradient, AI moments only
  | "dark" // white solid, for dark sections
  | "night-outline"; // outline for dark sections

type Size = "sm" | "md" | "lg";

const BASE =
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-xl font-medium transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-55";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-brand text-white shadow-cta hover:bg-brand-2 hover:-translate-y-px",
  secondary:
    "border border-line-2 bg-white text-ink shadow-[0_1px_2px_rgba(11,18,32,0.05)] hover:-translate-y-px hover:border-brand/40 hover:text-brand",
  ghost: "text-brand hover:bg-brand-soft",
  ai: "bg-gradient-to-r from-brand to-ai text-white shadow-cta hover:-translate-y-px hover:brightness-110",
  dark: "bg-white text-ink hover:-translate-y-px hover:bg-slate-100",
  "night-outline":
    "border border-white/25 text-snow hover:border-white/50 hover:bg-white/10",
};

const SIZES: Record<Size, string> = {
  sm: "h-9 px-3.5 text-[13px]",
  md: "h-11 px-5 text-sm",
  lg: "h-12 px-6 text-[15px]",
};

type CommonProps = {
  children: ReactNode;
  variant?: Variant;
  size?: Size;
  className?: string;
};

type ButtonProps = CommonProps & {
  href?: undefined;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  "aria-label"?: string;
};

type AnchorProps = CommonProps & {
  href: string;
  target?: string;
  rel?: string;
  onClick?: () => void;
  "aria-label"?: string;
};

/**
 * The OmniFlow button. Renders an <a> when href is given so server
 * sections stay server-rendered; client components can pass onClick.
 */
export default function Button(props: ButtonProps | AnchorProps) {
  const {
    children,
    variant = "primary",
    size = "md",
    className = "",
  } = props;
  const classes = `${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${className}`;
  if ("href" in props && props.href) {
    const { href, target, rel, onClick, "aria-label": ariaLabel } = props;
    return (
      <a
        href={href}
        target={target}
        rel={rel}
        onClick={onClick}
        aria-label={ariaLabel}
        className={classes}
      >
        {children}
      </a>
    );
  }
  const { onClick, type = "button", disabled, "aria-label": ariaLabel } =
    props as ButtonProps;
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={classes}
    >
      {children}
    </button>
  );
}
