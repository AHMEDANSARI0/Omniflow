# OmniFlow marketing site (§216 redesign)

Premium light-mode marketing site. Visual/UX reference: AutomateX (structure
and motion only; no copied text, assets, stats or testimonials).

## Where to change things

| What | Where |
| --- | --- |
| Hero, problem/solution, how it works, features, customer memory, trust, FAQ, final CTA, footer text, use cases, multi-channel, why OmniFlow | Admin CMS (`site_content` rows). `lib/content-defaults.ts` is only the fallback when no DB row exists. |
| Navbar items, footer columns | `lib/marketing/navigation.ts` |
| Navbar compact threshold | `NAVBAR_SCROLL_THRESHOLD` in `lib/marketing/site.ts` |
| CTA routes | `SITE_ROUTES` in `lib/marketing/site.ts` |
| Hero AI visual (future 3D bot) | `heroVisualAsset` in `lib/marketing/site.ts` (`null` = CSS placeholder; `{ kind: "image", ... }` for PNG/WebP/SVG; `{ kind: "video", ... }` for a muted loop). Lottie/WebGL: render through `<AIVisual>` children when the asset exists. |
| Automation templates | `lib/marketing/templates.ts` |
| Integrations + honest status (Live / Early access / Coming soon) | `lib/marketing/integrations.ts` (single source; hero chips, cards and diagrams read it) |
| Core story nodes | `lib/marketing/workflow.ts` |
| Live demo conversations + timing | `lib/marketing/live-demo.ts` |
| Dashboard preview (sample data) | `lib/marketing/dashboard.ts` |
| Section copy without a CMS form yet, mockup text | `lib/marketing/sections.ts` |
| Inner-page heroes, CTAs, pricing, about, security, contact | `lib/marketing/pages.ts` |
| Design tokens (marketing only) | `.of-site` block in `app/globals.css` (scoped so the dashboard tokens stay unchanged) |

## Structure

- `app/components/hero/` hero visual slot (`AIVisual`, `HeroVisual`, `BotVisualPlaceholder`)
- `app/components/home/` homepage-only sections (templates, integrations, live demo, mockups, feature visuals)
- `app/components/ui/` primitives (`Section`, `PageHero`, `PageCta`, `Icon`, `StatusIndicator`, `WorkflowNode`, `IntegrationCard`, `CountUp`)
- `app/components/hooks/` `useScrolled`, `useInView`, `useReducedMotion`

## Motion and performance

- No animation library on marketing pages: CSS transitions/keyframes plus
  small hooks. The hero is a server component with a CSS entrance.
- Continuous effects (connector streaks, marquee, floating cards) are
  transform/opacity only and stop under `prefers-reduced-motion`.
- The live demo runs once per view (setTimeout chain) and shows the final
  state for reduced-motion users and in server HTML.

## Accessibility notes

- Status is always text plus a dot, never colour alone.
- Success text uses `#067647` (AA). `#12B76A` is used for dots/fills only;
  muted `#98A2B3` is never used for body text (fails AA).

## Not included (later batches)

- Admin forms for the new data lists (templates, integrations, demo, nav).
- Testimonials: none until there are real customer quotes (Trust section
  stands in).
