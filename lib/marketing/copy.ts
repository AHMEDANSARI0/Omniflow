/**
 * Admin-editable page copy and product-mockup content (batch 218).
 *
 * A copy block is a nested object of text (section headings, inner-page
 * heroes and CTAs, mockup sample data). The code constants in
 * sections.ts / pages.ts / dashboard.ts stay the defaults; the edited
 * block is one `site_content` row holding the whole object.
 *
 * No per-field schema: the editor fields are DERIVED from the default's
 * shape (strings, string lists, numbers, toggles, nested objects and
 * fixed-length arrays), and `sanitizeCopy` walks the same shape, so a
 * stored row can never change the structure the components expect.
 * Empty or invalid values fall back to the default value. Isomorphic.
 */
import { DASHBOARD_PREVIEW } from "./dashboard";
import { cleanValue, type ListField } from "./fields";
import {
  ABOUT_STORY,
  ABOUT_VALUES_HEAD,
  BLOG_COPY,
  CONTACT_CARDS,
  PAGE_CTAS,
  PAGE_HEROES,
  PRICING_FEATURED_LABEL,
  PRICING_NOTE,
  SECURITY_NOTE,
} from "./pages";
import {
  CUSTOMER_PROFILE_SAMPLE,
  DASHBOARD_SECTION,
  FEATURE_VISUAL_DATA,
  HERO_SECTION,
  HOW_IT_WORKS_SECTION,
  INTEGRATIONS_SECTION,
  LIVE_DEMO_SECTION,
  MULTI_CHANNEL_DIAGRAM,
  STEP_MOCKUP_DATA,
  STORY_SECTION,
  TEMPLATES_SECTION,
  WHY_OMNIFLOW_STATES,
} from "./sections";

import type { IconName } from "./types";

export type CopyBlockSpec = {
  /** `site_content.section` that stores the block. */
  section: string;
  title: string;
  description: string;
  hubIcon: IconName; // §259: a registry name, not a symbol glyph
  defaults: object;
};

export const COPY_BLOCKS = {
  home_sections: {
    section: "copy_home_sections",
    title: "Homepage section copy",
    description: "Headings, intros and buttons of the homepage blocks that have no section form of their own.",
    hubIcon: "file",
    defaults: {
      hero: HERO_SECTION,
      story: STORY_SECTION,
      templates: TEMPLATES_SECTION,
      howItWorks: HOW_IT_WORKS_SECTION,
      integrations: INTEGRATIONS_SECTION,
      liveDemo: LIVE_DEMO_SECTION,
      dashboard: DASHBOARD_SECTION,
      multiChannel: MULTI_CHANNEL_DIAGRAM,
      whyStates: WHY_OMNIFLOW_STATES,
    },
  },
  home_mockups: {
    section: "copy_home_mockups",
    title: "Homepage product mockups",
    description: "Sample text inside the How-it-works mockups, feature visuals and customer profile.",
    hubIcon: "eye",
    defaults: {
      steps: STEP_MOCKUP_DATA,
      features: FEATURE_VISUAL_DATA,
      profile: CUSTOMER_PROFILE_SAMPLE,
    },
  },
  dashboard_preview: {
    section: "copy_dashboard_preview",
    title: "Dashboard preview",
    description: "Sample data in the homepage dashboard preview. Keep it clearly sample data, not reported results.",
    hubIcon: "dashboard",
    defaults: DASHBOARD_PREVIEW,
  },
  page_heroes: {
    section: "copy_page_heroes",
    title: "Inner page heroes",
    description: "Eyebrow, headline and intro at the top of each inner page. The emphasis part gets the brand gradient.",
    hubIcon: "megaphone",
    defaults: PAGE_HEROES,
  },
  page_ctas: {
    section: "copy_page_ctas",
    title: "Inner page CTAs",
    description: "The closing call-to-action band on inner pages and blog articles.",
    hubIcon: "target",
    defaults: PAGE_CTAS,
  },
  pricing_page: {
    section: "copy_pricing_page",
    title: "Pricing page copy",
    description: "The featured-plan badge and the note under the plans (plans themselves: Pricing plans).",
    hubIcon: "cart",
    defaults: { featuredLabel: PRICING_FEATURED_LABEL, note: PRICING_NOTE },
  },
  about_page: {
    section: "copy_about_page",
    title: "About page copy",
    description: "The story section and the principles heading (cards themselves: About page principles).",
    hubIcon: "heart-hand",
    defaults: { story: ABOUT_STORY, valuesHead: ABOUT_VALUES_HEAD },
  },
  other_pages: {
    section: "copy_other_pages",
    title: "Security, contact & blog copy",
    description: "The security note, the contact page cards and the small blog labels.",
    hubIcon: "globe",
    defaults: { securityNote: SECURITY_NOTE, contact: CONTACT_CARDS, blog: BLOG_COPY },
  },
} as const satisfies Record<string, CopyBlockSpec>;

export type CopyBlockKey = keyof typeof COPY_BLOCKS;
export type CopyValue<K extends CopyBlockKey> = (typeof COPY_BLOCKS)[K]["defaults"];

export function isCopyBlockKey(value: unknown): value is CopyBlockKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(COPY_BLOCKS, value);
}

/** Structural keys: anchors and colour tones stay code, never edited. */
const LOCKED_KEYS = new Set(["id", "tone"]);
const LONG_TEXT = 80;

/** Field type for one default leaf, from its key and value. */
function fieldFor(key: string, value: unknown): ListField | null {
  if (typeof value === "string") {
    if (key === "href") return { key, label: key, type: "href", max: 200 };
    if (key === "icon") return { key, label: key, type: "icon" };
    return value.length > LONG_TEXT
      ? { key, label: key, type: "textarea", max: Math.max(400, value.length * 2) }
      : { key, label: key, type: "text", max: Math.max(120, value.length * 3) };
  }
  if (typeof value === "number") return { key, label: key, type: "number" };
  if (typeof value === "boolean") return { key, label: key, type: "toggle" };
  if (Array.isArray(value) && value.length && value.every((item) => typeof item === "string")) {
    const longest = Math.max(...value.map((item) => item.length));
    return { key, label: key, type: "lines", max: Math.max(160, longest * 2), maxLines: Math.max(8, value.length) };
  }
  return null;
}

function humanize(segment: string) {
  if (/^\d+$/.test(segment)) return `#${Number(segment) + 1}`;
  const words = segment.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export type CopyGroup = { key: string; title: string; fields: ListField[] };

/** Editor fields derived from a block's defaults, grouped by top-level key. */
export function copyFields(defaults: object): CopyGroup[] {
  const groups: CopyGroup[] = [];
  const walk = (value: unknown, path: string[], fields: ListField[]) => {
    const key = path[path.length - 1];
    if (LOCKED_KEYS.has(key)) return;
    const field = fieldFor(key, value);
    if (field) {
      fields.push({ ...field, key: path.join("."), label: path.slice(1).map(humanize).join(" · ") || "Text" });
    } else if (value && typeof value === "object") {
      Object.entries(value).forEach(([child, item]) => walk(item, [...path, child], fields));
    }
  };
  for (const [key, value] of Object.entries(defaults)) {
    const fields: ListField[] = [];
    walk(value, [key], fields);
    if (fields.length) groups.push({ key, title: humanize(key), fields });
  }
  return groups;
}

/** Stored value merged onto the default's exact shape. */
function merge(defaults: unknown, raw: unknown, key: string): unknown {
  if (LOCKED_KEYS.has(key)) return defaults;
  if (typeof defaults === "boolean") return typeof raw === "boolean" ? raw : defaults;
  const field = fieldFor(key, defaults);
  if (field) return cleanValue(field, raw) ?? defaults;
  if (Array.isArray(defaults)) {
    const list = Array.isArray(raw) ? raw : [];
    return defaults.map((item, index) => merge(item, list[index], String(index)));
  }
  if (defaults && typeof defaults === "object") {
    const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    return Object.fromEntries(
      Object.entries(defaults).map(([child, value]) => [child, merge(value, source[child], child)])
    );
  }
  return defaults;
}

/** Validate a stored/posted block; anything unusable becomes the default. */
export function sanitizeCopy<K extends CopyBlockKey>(key: K, raw: unknown): CopyValue<K> {
  return merge(COPY_BLOCKS[key].defaults, raw, "") as CopyValue<K>;
}

/** Leaves of `value` that differ from `defaults` (undefined = no change). */
function diff(defaults: unknown, value: unknown): unknown {
  if (Array.isArray(defaults) && !defaults.every((item) => typeof item === "string")) {
    const list = Array.isArray(value) ? value : [];
    const out = defaults.map((item, index) => diff(item, list[index]));
    return out.some((item) => item !== undefined) ? out.map((item) => item ?? null) : undefined;
  }
  if (defaults && typeof defaults === "object" && !Array.isArray(defaults)) {
    const source = (value ?? {}) as Record<string, unknown>;
    const out = Object.entries(defaults).flatMap(([key, item]) => {
      const changed = diff(item, source[key]);
      return changed === undefined ? [] : [[key, changed] as const];
    });
    return out.length ? Object.fromEntries(out) : undefined;
  }
  return JSON.stringify(value) === JSON.stringify(defaults) ? undefined : value;
}

/**
 * What to store for a block: only the edited values. Untouched text keeps
 * following the code defaults, so later copy updates still reach the site.
 */
export function copyOverrides<K extends CopyBlockKey>(key: K, value: CopyValue<K>): Record<string, unknown> {
  return (diff(COPY_BLOCKS[key].defaults, value) ?? {}) as Record<string, unknown>;
}
