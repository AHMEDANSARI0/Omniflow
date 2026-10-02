/**
 * Admin-editable marketing lists (hybrid CMS, batches 217-218).
 *
 * Each list is stored as one `site_content` row (`{ items: [...] }`,
 * keyed by `section`), exactly like the existing section rows. The data
 * files in lib/marketing stay the code-level defaults: when a row is
 * missing, empty or unusable the website falls back to them.
 *
 * One schema per list drives everything: the admin editor renders its
 * fields from it, and `sanitizeList` validates both what the admin saves
 * and what the website reads, so bad data can never break a page.
 * Isomorphic on purpose (no server imports) - the client editor uses it.
 */
import { cleanValue, getPath, HREF_HINT, setPath, slugify, type ListField } from "./fields";
import { INTEGRATIONS, INTEGRATION_CATEGORIES, STATUS_META } from "./integrations";
import { DEMO_SCENARIOS } from "./live-demo";
import { FOOTER_COLUMNS, NAV_ITEMS, type NavItem } from "./navigation";
import {
  ABOUT_VALUES,
  FEATURE_PILLARS,
  PRICING_PLANS,
  SECURITY_AREAS,
  USE_CASE_SAMPLES,
} from "./pages";
import { FEATURE_VISUAL_KINDS } from "./sections";
import { AUTOMATION_TEMPLATES, TEMPLATE_CATEGORIES } from "./templates";
import { STORY_NODES } from "./workflow";

export type { ListField };

export type ListSpec = {
  /** `site_content.section` that stores the list. */
  section: string;
  title: string;
  description: string;
  hubIcon: string;
  /** Singular noun for buttons ("Add template"). */
  itemLabel: string;
  /** Field shown as each item's heading in the editor. */
  titleKey: string;
  /** Slug field filled from `titleKey` when left empty, kept unique. */
  idKey?: string;
  /** Layout depends on an exact count: items can be edited, not added or removed. */
  fixed?: boolean;
  maxItems: number;
  fields: readonly ListField[];
  defaults: readonly object[];
};

export type FooterLink = NavItem & { column: string };

const STATUS_OPTIONS = (Object.keys(STATUS_META) as (keyof typeof STATUS_META)[]).map((key) => ({
  value: key,
  label: STATUS_META[key].label,
}));

export const MARKETING_LISTS = {
  templates: {
    section: "marketing_templates",
    title: "Automation templates",
    description: "The template cards and their steps in the homepage templates section.",
    hubIcon: "⑂",
    itemLabel: "template",
    titleKey: "title",
    idKey: "id",
    maxItems: 24,
    fields: [
      { key: "title", label: "Title", type: "text", required: true, max: 80 },
      { key: "id", label: "Slug", type: "text", max: 60, hint: "Left empty, it is made from the title." },
      {
        key: "category",
        label: "Category",
        type: "select",
        required: true,
        options: TEMPLATE_CATEGORIES.filter((c) => c.key !== "all").map((c) => ({ value: c.key, label: c.label })),
      },
      { key: "icon", label: "Icon", type: "icon", required: true },
      { key: "description", label: "Description", type: "textarea", required: true, max: 240 },
      { key: "steps", label: "Steps", type: "lines", required: true, max: 60, hint: "One step per line (up to 6)." },
      { key: "cta", label: "Button label", type: "text", required: true, max: 30 },
    ],
    defaults: AUTOMATION_TEMPLATES,
  },
  integrations: {
    section: "marketing_integrations",
    title: "Integrations",
    description: "Channels and tools with their honest status, used on the homepage, the hero chips and /integrations.",
    hubIcon: "⇄",
    itemLabel: "integration",
    titleKey: "name",
    idKey: "id",
    maxItems: 40,
    fields: [
      { key: "name", label: "Name", type: "text", required: true, max: 40 },
      { key: "id", label: "Slug", type: "text", max: 40, hint: "Also the /integrations#anchor. Left empty, it is made from the name." },
      {
        key: "status",
        label: "Status",
        type: "select",
        required: true,
        options: STATUS_OPTIONS,
        hint: "Only mark Live what the product ships today.",
      },
      {
        key: "category",
        label: "Category",
        type: "select",
        required: true,
        options: INTEGRATION_CATEGORIES.map((c) => ({ value: c.key, label: c.label })),
      },
      { key: "mark", label: "Monogram", type: "text", required: true, max: 3, hint: "2-3 letters on the logo tile." },
      { key: "accent", label: "Accent colour", type: "color", required: true, hint: "Hex, e.g. #25D366." },
      { key: "icon", label: "Icon (optional)", type: "icon" },
      { key: "description", label: "Description", type: "textarea", required: true, max: 220 },
      { key: "points", label: "Highlights (optional)", type: "lines", max: 60, hint: "One per line (up to 6)." },
    ],
    defaults: INTEGRATIONS,
  },
  demo: {
    section: "marketing_demo",
    title: "Live demo scenarios",
    description: "The conversations played step by step in the homepage live demo.",
    hubIcon: "▷",
    itemLabel: "scenario",
    titleKey: "label",
    idKey: "id",
    maxItems: 6,
    fields: [
      { key: "label", label: "Tab label", type: "text", required: true, max: 40 },
      { key: "id", label: "Slug", type: "text", max: 40, hint: "Left empty, it is made from the tab label." },
      { key: "icon", label: "Icon", type: "icon", required: true },
      { key: "channel", label: "Channel", type: "text", required: true, max: 30 },
      { key: "customer.name", label: "Customer name", type: "text", required: true, max: 40 },
      { key: "customer.message", label: "Customer message", type: "textarea", required: true, max: 240 },
      { key: "understanding", label: "AI understanding steps", type: "lines", required: true, max: 60, hint: "One per line (up to 6)." },
      { key: "workflow", label: "Workflow actions", type: "lines", required: true, max: 60, hint: "One per line (up to 6)." },
      { key: "reply", label: "AI reply", type: "textarea", required: true, max: 300 },
      { key: "outcome", label: "Outcome line", type: "text", required: true, max: 60 },
    ],
    defaults: DEMO_SCENARIOS,
  },
  story: {
    section: "marketing_story",
    title: "Workflow story nodes",
    description: "The six connected nodes in the homepage intelligence story (message to action).",
    hubIcon: "⇉",
    itemLabel: "node",
    titleKey: "label",
    idKey: "key",
    fixed: true,
    maxItems: 6,
    fields: [
      { key: "label", label: "Label", type: "text", required: true, max: 40 },
      { key: "icon", label: "Icon", type: "icon", required: true },
      { key: "description", label: "Description", type: "textarea", required: true, max: 200 },
      { key: "status", label: "Status line", type: "text", required: true, max: 50 },
    ],
    defaults: STORY_NODES,
  },
  nav: {
    section: "marketing_nav",
    title: "Navigation links",
    description: "The top navbar links (desktop and mobile menu).",
    hubIcon: "⁙",
    itemLabel: "link",
    titleKey: "label",
    maxItems: 8,
    fields: [
      { key: "label", label: "Label", type: "text", required: true, max: 30 },
      { key: "href", label: "Link", type: "href", required: true, max: 200, hint: HREF_HINT },
    ],
    defaults: NAV_ITEMS,
  },
  footer: {
    section: "marketing_footer",
    title: "Footer links",
    description: "Footer link columns. Links with the same column name are grouped, in this order.",
    hubIcon: "▽",
    itemLabel: "link",
    titleKey: "label",
    maxItems: 40,
    fields: [
      { key: "column", label: "Column", type: "text", required: true, max: 30 },
      { key: "label", label: "Label", type: "text", required: true, max: 40 },
      { key: "href", label: "Link", type: "href", required: true, max: 200, hint: HREF_HINT },
    ],
    defaults: FOOTER_COLUMNS.flatMap((column) => column.links.map((link) => ({ column: column.title, ...link }))),
  },
  pricing_plans: {
    section: "marketing_pricing_plans",
    title: "Pricing plans",
    description: "The plan cards on /pricing. Keep prices honest - use \"Coming soon\" until pricing is final.",
    hubIcon: "■",
    itemLabel: "plan",
    titleKey: "name",
    maxItems: 4,
    fields: [
      { key: "name", label: "Plan name", type: "text", required: true, max: 40 },
      { key: "price", label: "Price line", type: "text", required: true, max: 30 },
      { key: "description", label: "Description", type: "textarea", required: true, max: 240 },
      { key: "points", label: "Included", type: "lines", required: true, max: 80, hint: "One per line (up to 6)." },
      { key: "featured", label: "Highlight this plan", type: "toggle" },
      { key: "cta.label", label: "Button label", type: "text", required: true, max: 30 },
      { key: "cta.href", label: "Button link", type: "href", required: true, max: 200, hint: HREF_HINT },
    ],
    defaults: PRICING_PLANS,
  },
  feature_pillars: {
    section: "marketing_feature_pillars",
    title: "Platform pillars",
    description: "The large alternating rows on /features, each with points and a product visual.",
    hubIcon: "◈",
    itemLabel: "pillar",
    titleKey: "title",
    maxItems: 6,
    fields: [
      { key: "eyebrow", label: "Eyebrow", type: "text", required: true, max: 30 },
      { key: "title", label: "Title", type: "text", required: true, max: 90 },
      { key: "copy", label: "Copy", type: "textarea", required: true, max: 320 },
      { key: "points", label: "Points", type: "lines", required: true, max: 80, hint: "One per line (up to 6)." },
      {
        key: "visual",
        label: "Product visual",
        type: "select",
        required: true,
        options: FEATURE_VISUAL_KINDS.map((kind) => ({ value: kind, label: kind })),
      },
    ],
    defaults: FEATURE_PILLARS,
  },
  about_values: {
    section: "marketing_about_values",
    title: "About page principles",
    description: "The principle cards on /about.",
    hubIcon: "✶",
    itemLabel: "principle",
    titleKey: "title",
    maxItems: 8,
    fields: [
      { key: "title", label: "Title", type: "text", required: true, max: 50 },
      { key: "icon", label: "Icon", type: "icon", required: true },
      { key: "copy", label: "Copy", type: "textarea", required: true, max: 280 },
    ],
    defaults: ABOUT_VALUES,
  },
  security_areas: {
    section: "marketing_security_areas",
    title: "Security page areas",
    description: "The cards on /security. Describe only what OmniFlow implements today.",
    hubIcon: "◉",
    itemLabel: "area",
    titleKey: "title",
    maxItems: 12,
    fields: [
      { key: "title", label: "Title", type: "text", required: true, max: 50 },
      { key: "icon", label: "Icon", type: "icon", required: true },
      { key: "copy", label: "Copy", type: "textarea", required: true, max: 280 },
    ],
    defaults: SECURITY_AREAS,
  },
  use_case_samples: {
    section: "marketing_use_case_samples",
    title: "Use case sample chats",
    description: "The sample customer message and AI reply shown with each use case tab (in tab order).",
    hubIcon: "⇄",
    itemLabel: "sample",
    titleKey: "q",
    fixed: true,
    maxItems: 5,
    fields: [
      { key: "q", label: "Customer message", type: "text", required: true, max: 120 },
      { key: "a", label: "AI reply", type: "textarea", required: true, max: 240 },
    ],
    defaults: USE_CASE_SAMPLES,
  },
} as const satisfies Record<string, ListSpec>;

export type MarketingListKey = keyof typeof MARKETING_LISTS;

/** Item type of each list (what the website components receive). */
export type MarketingListItem = {
  templates: (typeof AUTOMATION_TEMPLATES)[number];
  integrations: (typeof INTEGRATIONS)[number];
  demo: (typeof DEMO_SCENARIOS)[number];
  story: (typeof STORY_NODES)[number];
  nav: NavItem;
  footer: FooterLink;
  pricing_plans: (typeof PRICING_PLANS)[number];
  feature_pillars: (typeof FEATURE_PILLARS)[number];
  about_values: (typeof ABOUT_VALUES)[number];
  security_areas: (typeof SECURITY_AREAS)[number];
  use_case_samples: (typeof USE_CASE_SAMPLES)[number];
};

export function isMarketingListKey(value: unknown): value is MarketingListKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(MARKETING_LISTS, value);
}

/**
 * Validate a raw list (from the DB or the admin form). Items missing a
 * required field are dropped; slugs are filled and de-duplicated; the
 * list is capped at `maxItems` (fixed lists must match the default count).
 */
export function sanitizeList<K extends MarketingListKey>(key: K, raw: unknown): MarketingListItem[K][] {
  const spec: ListSpec = MARKETING_LISTS[key];
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const items: object[] = [];

  for (const entry of raw.slice(0, spec.maxItems)) {
    if (!entry || typeof entry !== "object") continue;
    let item: object = {};
    let valid = true;
    for (const field of spec.fields) {
      const value = cleanValue(field, getPath(entry, field.key));
      if (value === undefined) {
        if (field.required) valid = false;
        continue;
      }
      item = setPath(item, field.key, value);
    }
    if (!valid) continue;
    if (spec.idKey) {
      const base = slugify(String(getPath(item, spec.idKey) ?? getPath(item, spec.titleKey) ?? "")) || "item";
      let slug = base;
      for (let n = 2; seen.has(slug); n += 1) slug = `${base}-${n}`;
      seen.add(slug);
      item = setPath(item, spec.idKey, slug);
    }
    items.push(item);
  }

  if (spec.fixed && items.length !== spec.defaults.length) return [];
  return items as MarketingListItem[K][];
}

/** Group footer links into columns, keeping first-appearance order. */
export function groupFooterLinks(links: FooterLink[]) {
  const columns: { title: string; links: NavItem[] }[] = [];
  for (const { column, label, href } of links) {
    let group = columns.find((entry) => entry.title === column);
    if (!group) columns.push((group = { title: column, links: [] }));
    group.links.push({ label, href });
  }
  return columns;
}
