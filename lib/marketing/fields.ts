/**
 * Shared field vocabulary for the admin-editable marketing content
 * (lists in ./lists.ts, copy blocks in ./copy.ts): field types, value
 * cleaning and dotted-path helpers. Isomorphic - the client editors and
 * the server readers validate with the same rules.
 */
import { ICON_NAMES } from "./types";

export type FieldType =
  | "text"
  | "textarea"
  | "lines"
  | "select"
  | "icon"
  | "color"
  | "href"
  | "number"
  | "toggle";

export type ListField = {
  /** Dotted path into the item ("customer.name", "rows.0.label"). */
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: readonly { value: string; label: string }[];
  hint?: string;
  /** Max characters (per line for "lines"). */
  max?: number;
  /** Max lines for "lines" (default 6). */
  maxLines?: number;
};

export const ICON_OPTIONS = ICON_NAMES.map((name) => ({ value: name, label: name }));

export const SAFE_HREF = /^(\/(?!\/)|#|https?:\/\/|mailto:)/i;
export const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
export const HREF_HINT = "A site path (/pricing), an anchor (#templates) or a full https:// link.";

export function getPath(item: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (value, key) => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined),
    item
  );
}

/** Immutable set; numeric segments index into arrays (kept as arrays). */
export function setPath<T>(item: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split(".");
  const current = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
  const child = current[head];
  const next = rest.length ? setPath(child && typeof child === "object" ? child : {}, rest.join("."), value) : value;
  if (Array.isArray(current)) {
    const copy = [...current];
    copy[Number(head)] = next;
    return copy as T;
  }
  return { ...current, [head]: next } as T;
}

export function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** One clean value, or `undefined` when empty/invalid (toggles are always boolean). */
export function cleanValue(field: ListField, raw: unknown): unknown {
  if (field.type === "toggle") return raw === true;
  if (field.type === "number") {
    const value = typeof raw === "string" && raw.trim() ? Number(raw) : raw;
    return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1_000_000) : undefined;
  }
  if (field.type === "lines") {
    const lines = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split("\n") : [];
    const clean = lines
      .filter((line): line is string => typeof line === "string")
      .map((line) => line.trim().slice(0, field.max ?? 120))
      .filter(Boolean)
      .slice(0, field.maxLines ?? 6);
    return clean.length ? clean : undefined;
  }
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().slice(0, field.max ?? (field.type === "textarea" ? 600 : 160));
  if (!value) return undefined;
  switch (field.type) {
    case "select":
      return field.options?.some((option) => option.value === value) ? value : undefined;
    case "icon":
      return (ICON_NAMES as readonly string[]).includes(value) ? value : undefined;
    case "color":
      return HEX_COLOR.test(value) ? value : undefined;
    case "href":
      return SAFE_HREF.test(value) ? value : undefined;
    default:
      return value;
  }
}
