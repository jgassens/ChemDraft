import { describe, expect, it } from "vitest";
import { loadSystemFonts } from "./systemFonts";

describe("systemFonts", () => {
  it("returns fallback families plus the stored current family outside native runtime", async () => {
    const fonts = await loadSystemFonts(["Unavailable Lab Font"]);
    const families = fonts.map((font) => font.family);

    expect(families).toContain("Arial");
    expect(families).toContain("monospace");
    expect(families).toContain("Unavailable Lab Font");
    expect(fonts.find((font) => font.family === "Unavailable Lab Font")?.faces).toContainEqual({
      weight: 400,
      style: "normal"
    });
  });
});
