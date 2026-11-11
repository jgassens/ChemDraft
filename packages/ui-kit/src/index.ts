export interface ThemeTokenSet {
  background: string;
  surface: string;
  text: string;
  accent: string;
  border: string;
}

export const defaultThemeTokens: ThemeTokenSet = {
  background: "#f7f8fa",
  surface: "#ffffff",
  text: "#1f2933",
  accent: "#2563eb",
  border: "#d8dee8"
};

/** Original round-bracket pair, on the same 24-unit grid as the desktop line icons. */
export const roundBracketIconPath = "M8 4C3 8 3 16 8 20M16 4c5 4 5 12 0 16";
