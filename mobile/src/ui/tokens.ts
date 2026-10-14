/**
 * OmniFlow design tokens. Mirrors the web system in app/globals.css
 * (light-first SaaS: neutral canvas, indigo brand, violet AI, cyan flow)
 * plus a matching dark palette for the mobile surfaces. Keep this file the
 * single source of truth - components must never hardcode a hex value.
 */

export interface Palette {
  canvas: string;
  surface: string;
  soft: string;
  ink: string;
  ink2: string;
  ink3: string;
  line: string;
  line2: string;
  brand: string;
  brand2: string;
  brandSoft: string;
  ai: string;
  aiSoft: string;
  flow: string;
  flowSoft: string;
  ok: string;
  okSoft: string;
  warn: string;
  warnSoft: string;
  danger: string;
  dangerSoft: string;
  night: string;
  night2: string;
  snow: string;
  nightMuted: string;
}

export const lightPalette: Palette = {
  canvas: "#f8fafc",
  surface: "#ffffff",
  soft: "#f3f6fa",
  ink: "#0b1220",
  ink2: "#3f4f63",
  ink3: "#5c6b7c",
  line: "#d7e0ea",
  line2: "#c5d0dc",
  brand: "#4f46e5",
  brand2: "#4338ca",
  brandSoft: "#eef2ff",
  ai: "#7c3aed",
  aiSoft: "#f3e8ff",
  flow: "#06b6d4",
  flowSoft: "#ecfeff",
  ok: "#15803d",
  okSoft: "#ecfdf3",
  warn: "#f59e0b",
  warnSoft: "#fffbeb",
  danger: "#b91c1c",
  dangerSoft: "#fef2f2",
  night: "#080d18",
  night2: "#0d1422",
  snow: "#f8fafc",
  nightMuted: "#94a3b8",
};

export const darkPalette: Palette = {
  canvas: "#080d18",
  surface: "#0d1422",
  soft: "#121b2e",
  ink: "#f8fafc",
  ink2: "#c3cede",
  ink3: "#8fa0b8",
  line: "#202c42",
  line2: "#2b3a56",
  brand: "#6d68f0",
  brand2: "#827cf5",
  brandSoft: "#1b1f4b",
  ai: "#a379f7",
  aiSoft: "#2b1d4b",
  flow: "#38cfe6",
  flowSoft: "#0c2a33",
  ok: "#34c77b",
  okSoft: "#0d2a1d",
  warn: "#f7b23a",
  warnSoft: "#2c220b",
  danger: "#f0616d",
  dangerSoft: "#331418",
  night: "#080d18",
  night2: "#0d1422",
  snow: "#f8fafc",
  nightMuted: "#94a3b8",
};

export const spacing = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 10,
  md: 14,
  lg: 20,
  xl: 24,
  pill: 999,
} as const;

export const fontSize = {
  caption: 12,
  body: 15,
  sub: 16,
  title: 18,
  display: 24,
  hero: 30,
} as const;

export type ColorSchemeName = "light" | "dark";

export function paletteFor(scheme: ColorSchemeName): Palette {
  return scheme === "dark" ? darkPalette : lightPalette;
}
