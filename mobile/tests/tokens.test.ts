import {
  darkPalette,
  lightPalette,
  paletteFor,
  radius,
  spacing,
} from "@/ui/tokens";

const HEX_OR_RGBA = /^(#[0-9a-fA-F]{6}|rgba?\(.+\))$/;

describe("design tokens", () => {
  it("light and dark palettes expose identical keys", () => {
    expect(Object.keys(lightPalette).sort()).toEqual(
      Object.keys(darkPalette).sort(),
    );
  });

  it("every palette value is a valid color string", () => {
    for (const palette of [lightPalette, darkPalette]) {
      for (const [key, value] of Object.entries(palette)) {
        expect(value).toMatch(HEX_OR_RGBA);
        expect(key.length).toBeGreaterThan(0);
      }
    }
  });

  it("scale values are positive and ordered", () => {
    const sp = Object.values(spacing);
    for (let i = 1; i < sp.length; i += 1) {
      expect(sp[i]).toBeGreaterThan(sp[i - 1] ?? 0);
    }
    expect(radius.pill).toBeGreaterThan(radius.xl);
  });

  it("paletteFor maps schemes", () => {
    expect(paletteFor("light")).toBe(lightPalette);
    expect(paletteFor("dark")).toBe(darkPalette);
  });
});
