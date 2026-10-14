import {
  AI_INTELLIGENCE_DEFAULTS,
  CUSTOMER_MEMORY_DEFAULTS,
  FAQ_DEFAULTS,
  FEATURES_DEFAULTS,
  FINAL_CTA_DEFAULTS,
  FOOTER_DEFAULTS,
  HERO_DEFAULTS,
  HOW_IT_WORKS_DEFAULTS,
  MULTI_CHANNEL_DEFAULTS,
  PROBLEM_SOLUTION_DEFAULTS,
  TRUST_DEFAULTS,
  USE_CASES_DEFAULTS,
  WHY_OMNIFLOW_DEFAULTS,
} from "../content-defaults";
import { COPY_BLOCKS, copyFields, copyOverrides, isCopyBlockKey, sanitizeCopy, type CopyBlockKey } from "./copy";
import { getPath, setPath } from "./fields";
import { MARKETING_LISTS, sanitizeList, type MarketingListKey } from "./lists";

/**
 * §256 CMS overrides: which `site_content` rows still override the code
 * defaults, and how to hand a field back to the default. A stored value
 * that equals today's default is "pinned": it renders the same now, but a
 * later copy update in code would never reach the site. Tidying drops
 * pinned values only, so the rendered page never changes.
 */

/** Section forms (whole-object editors) and the defaults their readers merge onto. */
export const SECTION_DEFAULTS: Record<string, { title: string; defaults: Record<string, unknown> }> = {
  hero: { title: "Hero", defaults: HERO_DEFAULTS },
  ai_intelligence: { title: "AI Intelligence", defaults: AI_INTELLIGENCE_DEFAULTS },
  how_it_works: { title: "How It Works", defaults: HOW_IT_WORKS_DEFAULTS },
  problem_solution: { title: "Problem / Solution", defaults: PROBLEM_SOLUTION_DEFAULTS },
  features: { title: "Features", defaults: FEATURES_DEFAULTS },
  use_cases: { title: "Use cases", defaults: USE_CASES_DEFAULTS },
  why_omniflow: { title: "Why OmniFlow", defaults: WHY_OMNIFLOW_DEFAULTS },
  final_cta: { title: "Final CTA", defaults: FINAL_CTA_DEFAULTS },
  faq: { title: "FAQ", defaults: FAQ_DEFAULTS },
  multi_channel: { title: "Multi-Channel", defaults: MULTI_CHANNEL_DEFAULTS },
  footer: { title: "Footer", defaults: FOOTER_DEFAULTS },
  trust: { title: "Trust", defaults: TRUST_DEFAULTS },
  customer_memory: { title: "Customer Memory", defaults: CUSTOMER_MEMORY_DEFAULTS },
};

export type OverrideKind = "section" | "copy" | "list";

export type OverrideField = {
  /** Dotted path inside the row (`heading_line1`, `hero.bot.soon`, `items.3`). */
  path: string;
  label: string;
  stored: string;
  fallback: string;
  /** False for list items: a list is only reset as a whole. */
  resettable: boolean;
};

export type OverrideRow = {
  section: string;
  kind: OverrideKind;
  title: string;
  href: string;
  fields: OverrideField[];
  /** Stored values equal to the default (or unused) that tidying removes. */
  tidy: boolean;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const own = (value: unknown, key: string) =>
  Boolean(value) && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
  );
}

/** Same content regardless of key order (sanitized items list keys in schema order). */
export const sameContent = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const same = sameContent;
const humanize = (key: string) => key.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

function show(value: unknown): string {
  const text = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
  return text.length > 160 ? text.slice(0, 157) + "..." : text;
}

/** Top-level values of a section form that differ from its defaults (what to store). */
export function sectionOverrides(values: Record<string, unknown>, defaults: Record<string, unknown>) {
  return Object.fromEntries(
    Object.keys(defaults)
      .filter((key) => own(values, key) && !same(values[key], defaults[key]))
      .map((key) => [key, values[key]])
  );
}

type Spec =
  | { kind: "section"; title: string; href: string; defaults: Record<string, unknown> }
  | { kind: "copy"; title: string; href: string; key: CopyBlockKey }
  | { kind: "list"; title: string; href: string; key: MarketingListKey };

/** Every CMS row that has code defaults, by `site_content.section`. */
export function overrideSpecs(): Record<string, Spec> {
  const specs: Record<string, Spec> = {};
  for (const [section, { title, defaults }] of Object.entries(SECTION_DEFAULTS)) {
    specs[section] = { kind: "section", title, href: "/admin/content/" + section.replace(/_/g, "-"), defaults };
  }
  for (const key of Object.keys(COPY_BLOCKS) as CopyBlockKey[]) {
    if (!isCopyBlockKey(key)) continue;
    specs[COPY_BLOCKS[key].section] = { kind: "copy", title: COPY_BLOCKS[key].title, href: "/admin/content/copy/" + key, key };
  }
  for (const key of Object.keys(MARKETING_LISTS) as MarketingListKey[]) {
    specs[MARKETING_LISTS[key].section] = { kind: "list", title: MARKETING_LISTS[key].title, href: "/admin/content/lists/" + key, key };
  }
  return specs;
}

function leaves(value: unknown, prefix: string, out: [string, unknown][]) {
  if (Array.isArray(value) && !value.every((item) => typeof item === "string")) {
    value.forEach((item, index) => item !== null && leaves(item, prefix + index + ".", out));
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) leaves(item, prefix + key + ".", out);
  } else {
    out.push([prefix.slice(0, -1), value]);
  }
  return out;
}

/** The minimal row that renders exactly like `stored` (pinned values dropped). */
export function tidyRow(section: string, stored: unknown): Record<string, unknown> {
  const spec = overrideSpecs()[section];
  const data = isObject(stored) ? stored : {};
  if (!spec) return data;
  if (spec.kind === "section") return sectionOverrides(data, spec.defaults);
  if (spec.kind === "copy") return copyOverrides(spec.key, sanitizeCopy(spec.key, data));
  const items = sanitizeList(spec.key, data.items);
  return !items.length || same(items, MARKETING_LISTS[spec.key].defaults) ? {} : data;
}

/** What one stored row overrides; null when it overrides nothing and holds nothing to tidy. */
export function overrideRow(section: string, stored: unknown): OverrideRow | null {
  const spec = overrideSpecs()[section];
  if (!spec) return null;
  const data = isObject(stored) ? stored : {};
  const minimal = tidyRow(section, data);
  let fields: OverrideField[] = [];
  if (spec.kind === "section") {
    fields = Object.entries(minimal).map(([key, value]) => ({
      path: key,
      label: humanize(key),
      stored: show(value),
      fallback: show(spec.defaults[key]),
      resettable: true,
    }));
  } else if (spec.kind === "copy") {
    const defaults = COPY_BLOCKS[spec.key].defaults;
    const labels = new Map(
      copyFields(defaults).flatMap((group) => group.fields.map((f) => [f.key, group.title + " · " + f.label] as const))
    );
    fields = leaves(minimal, "", []).map(([path, value]) => ({
      path,
      label: labels.get(path) ?? path,
      stored: show(value),
      fallback: show(getPath(defaults, path)),
      resettable: true,
    }));
  } else if (Array.isArray(minimal.items)) {
    const list = MARKETING_LISTS[spec.key];
    const items = sanitizeList(spec.key, minimal.items) as unknown[];
    const defaults = list.defaults as readonly unknown[];
    for (let index = 0; index < Math.max(items.length, defaults.length); index += 1) {
      if (same(items[index], defaults[index])) continue;
      const name = show(getPath(items[index] ?? defaults[index], list.titleKey)) || list.itemLabel + " " + (index + 1);
      fields.push({
        path: "items." + index,
        label: humanize(list.itemLabel) + " " + (index + 1) + ": " + name,
        stored: items[index] === undefined ? "(not in the saved list)" : show(items[index]),
        fallback: defaults[index] === undefined ? "(not in the default list)" : show(defaults[index]),
        resettable: false,
      });
    }
  }
  const tidy = !same(minimal, data);
  if (!fields.length && !tidy) return null;
  return { section, kind: spec.kind, title: spec.title, href: spec.href, fields, tidy };
}

/** The row with one field handed back to the code default. */
export function resetOverride(section: string, stored: unknown, path: string): Record<string, unknown> | null {
  const spec = overrideSpecs()[section];
  if (!spec || spec.kind === "list") return null;
  const data = tidyRow(section, stored);
  if (spec.kind === "section") {
    if (!own(spec.defaults, path)) return null;
    return Object.fromEntries(Object.entries(data).filter(([key]) => key !== path));
  }
  const defaults = COPY_BLOCKS[spec.key].defaults;
  let cursor: unknown = defaults;
  for (const key of path.split(".")) {
    if (!own(cursor, key)) return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  const fallback = getPath(defaults, path);
  if (fallback === undefined || isObject(fallback)) return null;
  return copyOverrides(spec.key, sanitizeCopy(spec.key, setPath(sanitizeCopy(spec.key, data), path, fallback)));
}
