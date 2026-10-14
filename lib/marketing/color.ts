/**
 * Colour helpers for CMS-driven fills (§258).
 *
 * Integration logos and the website-chat launcher are painted with a colour
 * the admin chooses (a brand hex per integration, a tenant accent). White
 * text on top of that is only safe sometimes: WhatsApp's green gives 2.0:1,
 * Messenger blue 3.7:1, while a near-black accent flips the problem. So the
 * ink is picked from the fill instead of being hardcoded.
 *
 * Pure and dependency-free on purpose: it runs in server components and in
 * the client chat widget alike.
 */

const INK = "#0b1220";
const SNOW = "#ffffff";

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of an sRGB colour, or null when it cannot be parsed. */
export function relativeLuminance(color: string): number | null {
  const hex = color.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  if (short) {
    const [r, g, b] = [short[1], short[2], short[3]].map((c) => parseInt(c + c, 16));
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }
  const full = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (full) {
    const [r, g, b] = [full[1], full[2], full[3]].map((c) => parseInt(c, 16));
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(hex);
  if (rgb) {
    const parts = [rgb[1], rgb[2], rgb[3]].map(Number);
    if (parts.some((v) => v > 255)) return null;
    const [r, g, b] = parts;
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }
  return null;
}

function contrastWith(white: boolean, luminance: number): number {
  return white ? 1.05 / (luminance + 0.05) : (luminance + 0.05) / 0.05;
}

/**
 * The ink colour that stays readable on `fill`: white or near-black,
 * whichever has the higher WCAG contrast. Unknown or malformed colours keep
 * today's behaviour (white), so a bad value can never blank out a label.
 */
export function readableInk(fill: string | null | undefined): string {
  const luminance = typeof fill === "string" ? relativeLuminance(fill) : null;
  if (luminance === null) return SNOW;
  return contrastWith(true, luminance) >= contrastWith(false, luminance) ? SNOW : INK;
}
