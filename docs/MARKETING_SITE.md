# OmniFlow marketing site (§216 redesign)

Premium light-mode marketing site. Visual/UX reference: AutomateX (structure
and motion only; no copied text, assets, stats or testimonials).

## Where to change things

| What | Where |
| --- | --- |
| Hero, problem/solution, how it works, features, customer memory, trust, FAQ, final CTA, footer text, use cases, multi-channel, why OmniFlow | Admin CMS (`site_content` rows). `lib/content-defaults.ts` is only the fallback when no DB row exists. |
| Navbar links, footer links | **Admin → Content → Navigation links / Footer links** (default: `lib/marketing/navigation.ts`) |
| Navbar compact threshold | `NAVBAR_SCROLL_THRESHOLD` in `lib/marketing/site.ts` |
| CTA routes | `SITE_ROUTES` in `lib/marketing/site.ts` |
| Hero AI visual (future 3D bot) | `heroVisualAsset` in `lib/marketing/site.ts` (`null` = CSS placeholder; `{ kind: "image", ... }` for PNG/WebP/SVG; `{ kind: "video", ... }` for a muted loop). Lottie/WebGL: render through `<AIVisual>` children when the asset exists. |
| Automation templates | **Admin → Content → Automation templates** (default: `lib/marketing/templates.ts`) |
| Integrations + honest status (Live / Early access / Coming soon) | **Admin → Content → Integrations** (default: `lib/marketing/integrations.ts`; single source - hero chips, cards and diagrams read it) |
| Core story nodes (exactly 6) | **Admin → Content → Workflow story nodes** (default: `lib/marketing/workflow.ts`) |
| Live demo conversations | **Admin → Content → Live demo scenarios** (default: `lib/marketing/live-demo.ts`; timing stays in code) |
| Pricing plans, /features pillars, /about principles, /security areas, use case sample chats | **Admin → Content → Lists** (defaults: `lib/marketing/pages.ts`) |
| Homepage section headings, mockup sample text, dashboard preview, inner-page heroes and CTAs, pricing/about/security/contact/blog copy | **Admin → Content → Page copy & product mockups** (defaults: `lib/marketing/sections.ts`, `pages.ts`, `dashboard.ts`) |
| Layout mappings (mockup per step, visual per feature, capability icons) | `lib/marketing/sections.ts` (code on purpose) |
| Design tokens (marketing only) | `.of-site` block in `app/globals.css` (scoped so the dashboard tokens stay unchanged) |

## Editable lists (batch 217)

- One schema per list in `lib/marketing/lists.ts` (`MARKETING_LISTS`): fields, limits, defaults.
  Adding a list = one entry there + reading it with `getMarketingList(key)`; the admin hub card and
  editor (`/admin/content/lists/<key>`) come from the config.
- Stored as `site_content` rows (`marketing_templates`, `marketing_integrations`, `marketing_demo`,
  `marketing_story`, `marketing_nav`, `marketing_footer`) holding `{ items: [...] }` - no migration.
- `sanitizeList` validates on save AND on read (required fields, allowed options/icons, hex colours,
  safe links only, length and count caps, unique slugs). Missing/empty/invalid rows fall back to the
  defaults, so the site never breaks. "Reset to defaults" stores an empty row.
- Saving requires an admin profile (checked inside the server action too) and revalidates the site.
- Batch 218 added `pricing_plans`, `feature_pillars`, `about_values`, `security_areas` and the fixed
  `use_case_samples` (5, matched by position to the CMS use case tabs), plus the `toggle` field type.

## Editable page copy (batch 218)

- `lib/marketing/copy.ts` (`COPY_BLOCKS`): eight blocks, each a nested object whose default is the
  code constant. No per-field schema: `copyFields` derives the editor fields from the default's shape
  (text / long text / link / icon / number / toggle / line list; nested objects and fixed-length
  arrays), labelled from the key path and grouped by top-level key.
- Stored as `site_content` rows `copy_<block>` holding **only the edited values**
  (`copyOverrides`), so untouched text keeps following the code defaults when they change.
- `sanitizeCopy` walks the default's shape on save and on read: wrong types, empty values, unsafe
  links and unknown icons fall back to the default; unknown keys are dropped; arrays keep their
  length; `id` and `tone` (anchors, colours) are locked to the code values.
- Components read `getCopy(block)` (cached per request, like `getMarketingList`); the two client
  components (templates, live demo) receive their copy as a prop from the page.
- Shared field rules live in `lib/marketing/fields.ts`; shared editor inputs in
  `app/admin/(panel)/content/editor-ui.tsx`; the admin gate and row write in `lib/supabase/site-admin.ts`.

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

- Testimonials: none until there are real customer quotes (Trust section
  stands in).
