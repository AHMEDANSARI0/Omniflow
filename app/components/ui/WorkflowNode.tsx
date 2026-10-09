import type { IconName } from "../../../lib/marketing/types";
import Icon from "./Icon";

/**
 * One node in an OmniFlow workflow diagram: icon, step number, label,
 * description and a live status line. Pure presentation; connectors
 * are drawn by the parent so layouts can change per breakpoint.
 */
export default function WorkflowNode({
  index,
  icon,
  label,
  description,
  status,
  highlight = false,
}: {
  index: number;
  icon: IconName;
  label: string;
  description: string;
  status: string;
  highlight?: boolean;
}) {
  return (
    <article
      className={`of-hover-lift group relative h-full rounded-xl3 border bg-white p-5 shadow-card ${
        highlight ? "border-brand/30" : "border-line"
      }`}
    >
      <div className="flex items-center justify-between">
        <span
          aria-hidden
          className={`inline-flex h-11 w-11 items-center justify-center rounded-xl2 border transition-colors duration-300 ${
            highlight
              ? "of-gradient-deep border-transparent text-white"
              : "border-brand/15 bg-brand-soft text-brand group-hover:border-brand/30"
          }`}
        >
          <Icon name={icon} className="h-5 w-5" />
        </span>
        <span className="font-display text-xs font-semibold tabular-nums text-ink-3">
          {String(index).padStart(2, "0")}
        </span>
      </div>
      <h3 className="mt-4 text-[15px] font-semibold text-ink">{label}</h3>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">{description}</p>
      <p className="mt-4 inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-ok">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-success" />
        {status}
      </p>
    </article>
  );
}
