import { Check } from "lucide-react";
import type { Integration } from "../../../lib/marketing/integrations";
import { INTEGRATION_CATEGORIES } from "../../../lib/marketing/integrations";
import { AvailabilityBadge } from "./StatusIndicator";
import Icon from "./Icon";

/** Logo tile: lucide icon when the integration has one, else a monogram. */
export function IntegrationLogo({
  integration,
  size = "md",
}: {
  integration: Integration;
  size?: "sm" | "md";
}) {
  const box = size === "sm" ? "h-7 w-7 rounded-lg text-[10px]" : "h-11 w-11 rounded-xl2 text-[13px]";
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center font-display font-bold text-white shadow-[inset_0_-1px_0_rgba(0,0,0,0.12)] ${box}`}
      style={{ backgroundColor: integration.accent }}
    >
      {integration.icon ? (
        <Icon name={integration.icon} className={size === "sm" ? "h-3.5 w-3.5" : "h-5 w-5"} />
      ) : (
        integration.mark
      )}
    </span>
  );
}

/** Integration card: logo, name, category, honest status, description. */
export default function IntegrationCard({
  integration,
  showPoints = false,
}: {
  integration: Integration;
  showPoints?: boolean;
}) {
  const category =
    INTEGRATION_CATEGORIES.find((item) => item.key === integration.category)?.label ??
    integration.category;
  return (
    <article
      id={integration.id}
      className="of-hover-lift flex h-full scroll-mt-28 flex-col rounded-xl3 border border-line bg-white p-5 shadow-card"
    >
      <div className="flex items-start justify-between gap-3">
        <IntegrationLogo integration={integration} />
        <AvailabilityBadge status={integration.status} />
      </div>
      <h3 className="mt-4 font-display text-[17px] font-semibold text-ink">{integration.name}</h3>
      <p className="text-[12px] font-medium text-ink-3">{category}</p>
      <p className="mt-2.5 text-[14px] leading-relaxed text-ink-2">{integration.description}</p>
      {showPoints && integration.points?.length ? (
        <ul className="mt-4 space-y-1.5 border-t border-line pt-4">
          {integration.points.map((point) => (
            <li key={point} className="flex items-start gap-2 text-[13px] text-ink-2">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" aria-hidden />
              {point}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
