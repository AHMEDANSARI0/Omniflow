import { Check, MessageCircle, Sparkles, Zap } from "lucide-react";
import AIVisual from "./AIVisual";
import BotVisualPlaceholder from "./BotVisualPlaceholder";
import { heroVisualAsset } from "../../../lib/marketing/site";
import { HERO_SECTION, HERO_VISUAL_CARDS } from "../../../lib/marketing/sections";

const delay = (ms: number) => ({ ["--of-delay" as string]: `${ms}ms` });

/**
 * Hero visual: the AI slot (future 3D bot via `heroVisualAsset`) with
 * floating product cards and faint workflow lines around it.
 */
export default function HeroVisual() {
  const cards = HERO_VISUAL_CARDS;
  return (
    <div
      className="of-enter relative mx-auto w-full max-w-[440px] sm:max-w-[520px] lg:max-w-[560px]"
      style={delay(160)}
      role="img"
      aria-label={`${HERO_SECTION.visualLabel}: a ${cards.message.channel} message is understood, intent is detected and a workflow runs automatically.`}
    >
      <AIVisual asset={heroVisualAsset} fallback={<BotVisualPlaceholder />} priority>
        {/* workflow lines (decorative) */}
        <svg
          aria-hidden
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 h-full w-full"
        >
          <path d="M22 22 C 34 30, 40 38, 50 50" stroke="rgba(99,91,255,0.28)" strokeWidth="0.35" strokeDasharray="1.4 1.4" fill="none" />
          <path d="M84 44 C 72 46, 62 48, 50 50" stroke="rgba(99,91,255,0.28)" strokeWidth="0.35" strokeDasharray="1.4 1.4" fill="none" />
          <path d="M20 80 C 32 70, 40 60, 50 50" stroke="rgba(14,165,233,0.3)" strokeWidth="0.35" strokeDasharray="1.4 1.4" fill="none" />
          <path d="M80 84 C 70 72, 60 60, 50 50" stroke="rgba(18,183,106,0.3)" strokeWidth="0.35" strokeDasharray="1.4 1.4" fill="none" />
        </svg>

        {/* incoming message */}
        <div className="of-enter absolute left-0 top-[6%] w-[58%] max-w-[250px]" style={delay(380)}>
          <div className="of-float rounded-2xl border border-line bg-white/95 p-3 shadow-card-hover">
            <p className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              <MessageCircle className="h-3 w-3 text-[#128C7E]" aria-hidden />
              {cards.message.channel} · {cards.message.meta}
            </p>
            <p className="mt-2 rounded-xl rounded-tl-sm bg-soft px-3 py-2 text-[12.5px] leading-snug text-ink">
              {cards.message.text}
            </p>
          </div>
        </div>

        {/* intent */}
        <div className="of-enter absolute right-0 top-[34%] w-[44%] max-w-[200px]" style={delay(560)}>
          <div className="of-float rounded-2xl border border-line bg-white/95 p-3 shadow-card-hover [animation-delay:1.2s]">
            <p className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              <Sparkles className="h-3 w-3 text-brand" aria-hidden />
              {cards.intent.label}
            </p>
            <p className="mt-1.5 flex items-center justify-between text-[13px] font-semibold text-ink">
              {cards.intent.value}
              <span className="rounded-full border border-brand/20 bg-brand-soft px-2 py-0.5 text-[10.5px] font-semibold text-brand-2">
                {cards.intent.strength}
              </span>
            </p>
          </div>
        </div>

        {/* workflow */}
        <div className="of-enter absolute bottom-[4%] left-[2%] w-[54%] max-w-[230px]" style={delay(740)}>
          <div className="of-float rounded-2xl border border-line bg-white/95 p-3 shadow-card-hover [animation-delay:2.1s]">
            <p className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              <Zap className="h-3 w-3 text-flow" aria-hidden />
              {cards.workflow.label}
            </p>
            <ul className="mt-2 space-y-1.5">
              {cards.workflow.steps.map((step) => (
                <li key={step} className="flex items-center gap-2 text-[12px] font-medium text-ink-2">
                  <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-ok-soft text-ok">
                    <Check className="h-2.5 w-2.5" aria-hidden />
                  </span>
                  {step}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* outcome */}
        <div className="of-enter absolute bottom-[12%] right-[2%] hidden sm:block" style={delay(920)}>
          <p className="of-float inline-flex items-center gap-2 rounded-full border border-ok/20 bg-white px-3 py-1.5 text-[12px] font-semibold text-ok shadow-card-hover [animation-delay:0.6s]">
            <span aria-hidden className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-success text-white">
              <Check className="h-2.5 w-2.5" />
            </span>
            {cards.outcome.label}
          </p>
        </div>
      </AIVisual>
    </div>
  );
}
