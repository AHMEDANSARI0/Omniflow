import React, { createContext, useContext, useMemo } from "react";
import { useColorScheme } from "react-native";
import {
  ColorSchemeName,
  Palette,
  darkPalette,
  lightPalette,
} from "@/ui/tokens";

export interface Theme {
  scheme: ColorSchemeName;
  colors: Palette;
}

const ThemeContext = createContext<Theme>({
  scheme: "light",
  colors: lightPalette,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const value = useMemo<Theme>(
    () => ({
      scheme: system === "dark" ? "dark" : "light",
      colors: system === "dark" ? darkPalette : lightPalette,
    }),
    [system],
  );
  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
