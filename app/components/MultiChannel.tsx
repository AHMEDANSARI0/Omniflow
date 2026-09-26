import { ArrowRight, Inbox, Workflow } from "lucide-react";
import type { MultiChannelContent } from "../../lib/content-defaults";
import Reveal from "./Reveal";
import Section, { SectionHead } from "./ui/Section";
import Card from "./ui/Card";
import Badge from "./ui/Badge";

/**
 * One intelligence layer, every channel. WhatsApp is live; the other
 * channels are shown honestly as "expanding". Server component.
 */
export default function MultiChannel({
  content,
}: {
  content: MultiChannelContent;
}) {
  const channels = [
    { name: content.c1_name, short: content.c1_short, desc: content.c1_desc },
    { name: content.c2_name, short: content.c2_short, desc: content.c2_desc },
    { name: content.c3_name, short: content.c3_short, desc: content.c3_desc },
    { name: content.c4_name, short: content.c4_short, desc: content.c4_desc },
  ];
  const actions = content.actions
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return (
    <Section id="channels" tone="white">
      <SectionHead
        eyebrow={content.badge}
        title={
          <>
            {content.heading_line1} {content.heading_line2}
          </>
        }
        copy={content.description}
      />

      <div className="mt-14 grid items-center gap-6 lg:grid-cols-[1fr_1.1fr]">
        <div className="grid gap-3 sm:grid-cols-2">
          {channels.map(({ name, short, desc }, index) => {
            const live = index === 0;
            return (
              <Reveal key={name} lift>
                <Card
                  className={`flex h-full items-center gap-3.5 p-4.5 ${
                    live ? "border-ok/25" : ""
                  }`}
                >
                  <span
                    aria-hidden
                    className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl2 border font-display text-[13px] font-bold ${
                      live
                        ? "border-ok/25 bg-ok-soft text-ok"
                        : "border-line bg-soft text-ink-3"
                    }`}
                  >
                    {short}
                  </span>
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                      {name}
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wider ${
                          live
                            ? "bg-ok-soft text-ok"
                            : "bg-soft text-ink-3"
                        }`}
                      >
                        {live ? "Live" : "Expanding"}
                      </span>
                    </p>
                    <p className="truncate text-[12px] text-ink-3">{desc}</p>
                  </div>
                </Card>
              </Reveal>
            );
          })}
        </div>

        <Reveal lift>
          <Card gradientRing className="p-7">
            <div className="flex items-center gap-2.5">
              <span
                aria-hidden
                className="of-gradient inline-flex h-9 w-9 items-center justify-center rounded-xl"
              >
                <Workflow className="h-4.5 w-4.5 text-white" />
              </span>
              <div>
                <p className="text-sm font-semibold text-ink">
                  {content.workflow_title}
                </p>
                <p className="text-[12px] text-ink-3">
                  {content.workflow_subtitle}
                </p>
              </div>
            </div>

            <div className="mt-6 space-y-3">
              <div className="flex items-center gap-3 rounded-xl2 border border-line bg-soft px-4 py-3">
                <Inbox className="h-4 w-4 shrink-0 text-brand" aria-hidden />
                <p className="text-[13px] font-medium text-ink-2">
                  Customer writes — on any connected channel
                </p>
              </div>
              <div className="flex justify-center">
                <span aria-hidden className="h-4 w-px bg-line-2" />
              </div>
              <div className="of-gradient rounded-xl2 px-4 py-3.5">
                <p className="flex items-center gap-2 text-[13px] font-semibold text-white">
                  <Workflow className="h-4 w-4 shrink-0" aria-hidden />
                  One OmniFlow workflow decides and acts
                </p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {actions.map((action) => (
                    <span
                      key={action}
                      className="rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-medium text-white"
                    >
                      {action}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <p className="mt-5 flex items-center gap-2 text-[13px] text-ink-2">
              <ArrowRight className="h-4 w-4 shrink-0 text-brand" aria-hidden />
              {content.bottom_note}
            </p>
            <div className="mt-4">
              <Badge tone="neutral">Same AI · Same workflows · Same dashboard</Badge>
            </div>
          </Card>
        </Reveal>
      </div>
    </Section>
  );
}
