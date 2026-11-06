import { expect, it, vi } from "vitest";
import { loadSystemFonts } from "./systemFonts";

vi.mock("./window-manager", () => ({ isDesktopRuntime: () => true }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async () => [
    { family: ".AppleSystemUIFont", faces: [{ weight: 400, style: "normal" }] },
    { family: " .Hidden Font ", faces: [{ weight: 400, style: "normal" }] },
    { family: "Visible Font", faces: [{ weight: 400, style: "normal" }] }
  ]
}));

it("omits dot-prefixed system font families from the picker catalog", async () => {
  const families = (await loadSystemFonts()).map(font => font.family);
  expect(families).toContain("Visible Font");
  expect(families).not.toContain(".AppleSystemUIFont");
  expect(families).not.toContain(".Hidden Font");
});
