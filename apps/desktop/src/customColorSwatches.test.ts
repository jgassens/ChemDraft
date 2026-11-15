import { describe, expect, it } from "vitest";
import { allCustomSwatchCommandIds, clearCustomSwatchSlot, CMYK_APPROXIMATION_NOTE, CUSTOM_SWATCH_COUNT, customSwatchCommandId, hexToRgb, loadCustomSwatches, parseCmykColorInput, parseCustomSwatchCommandId, parseHexColorInput, parseRgbColorInput, rgbToCmyk, saveCustomSwatches, setCustomSwatchSlot, type SwatchStorage } from "./customColorSwatches";

describe("custom swatch commands", () => {
  it("round trips every swatch, slot, and action in stable order", () => {
    const ids = allCustomSwatchCommandIds();
    expect(CUSTOM_SWATCH_COUNT).toBe(4);
    expect(ids).toHaveLength(24);
    expect(new Set(ids).size).toBe(24);
    let index = 0;
    for (const swatch of [1, 2, 3, 4] as const) for (const slot of [1, 2] as const) for (const action of ["apply", "edit", "clear"] as const) {
      const id = customSwatchCommandId(swatch, slot, action);
      expect(ids[index++]).toBe(id);
      expect(parseCustomSwatchCommandId(id)).toEqual({ swatch, slot, action });
    }
  });
  it.each(["color.customSwatch.0.slot1.apply", "color.customSwatch.5.slot1.apply", "color.customSwatch.01.slot1.apply", "color.customSwatch.1.slot0.apply", "color.customSwatch.1.slot3.apply", "color.customSwatch.1.slot01.apply", "color.customSwatch.1.slot1.set", "color.customSwatch.1.slot1.apply.extra", "color.customSwatch.1.slot1.apply\n"])('rejects %s', (id) => {
    expect(parseCustomSwatchCommandId(id)).toBeUndefined();
  });
});

describe("color input", () => {
  it.each(["#abc", "abc", " #AbC ", "#AABBCC", "aabbcc"])('normalizes %s', (input) => {
    expect(parseHexColorInput(input)).toEqual({ ok: true, hex: "#aabbcc", approximate: false });
  });
  it("explains invalid hex and alpha", () => {
    expect(parseHexColorInput("#12g")).toEqual({ ok: false, message: 'Hex color must be 3 or 6 hex digits, got "#12g"' });
    expect(parseHexColorInput("#11223344")).toEqual({ ok: false, message: 'Hex color alpha is not supported, got "#11223344"' });
    expect(parseHexColorInput("#abcd")).toEqual({ ok: false, message: 'Hex color alpha is not supported, got "#abcd"' });
  });
  it("parses RGB and names the invalid channel", () => {
    expect(parseRgbColorInput(" 255 ", 16, "0")).toEqual({ ok: true, hex: "#ff1000", approximate: false });
    expect(parseRgbColorInput(300, 0, 0)).toEqual({ ok: false, message: "Red must be a whole number from 0 to 255, got 300" });
    expect(parseRgbColorInput(0, "1.5", 0)).toEqual({ ok: false, message: "Green must be a whole number from 0 to 255, got 1.5" });
    expect(parseRgbColorInput(0, 0, "")).toEqual({ ok: false, message: "Blue must be a whole number from 0 to 255, got " });
  });
  it("converts CMYK approximately and names invalid channels", () => {
    expect(CMYK_APPROXIMATION_NOTE).toBe("Approximate: CMYK is converted to screen RGB without a color profile.");
    expect(parseCmykColorInput(0, 0, 0, 0)).toEqual({ ok: true, hex: "#ffffff", approximate: true });
    expect(parseCmykColorInput(0, 0, 0, 100)).toEqual({ ok: true, hex: "#000000", approximate: true });
    expect(parseCmykColorInput(100, 0, 0, 0)).toEqual({ ok: true, hex: "#00ffff", approximate: true });
    expect(parseCmykColorInput("50.5", "0", 0, 0)).toEqual({ ok: true, hex: "#7effff", approximate: true });
    expect(parseCmykColorInput(-5, 0, 0, 0)).toEqual({ ok: false, message: "Cyan must be a percentage from 0 to 100, got -5" });
    expect(parseCmykColorInput(0, 101, 0, 0)).toEqual({ ok: false, message: "Magenta must be a percentage from 0 to 100, got 101" });
    expect(parseCmykColorInput(0, 0, "no", 0)).toEqual({ ok: false, message: "Yellow must be a percentage from 0 to 100, got no" });
    expect(parseCmykColorInput(0, 0, 0, "")).toEqual({ ok: false, message: "Black must be a percentage from 0 to 100, got " });
  });
  it("converts stored colors for prefill", () => {
    const rgb = hexToRgb("#12aBef")!;
    expect(rgb).toEqual({ r: 18, g: 171, b: 239 });
    expect(parseRgbColorInput(rgb.r, rgb.g, rgb.b)).toEqual({ ok: true, hex: "#12abef", approximate: false });
    expect(hexToRgb("bad hex")).toBeUndefined();
    expect(rgbToCmyk(0, 0, 0)).toEqual({ c: 0, m: 0, y: 0, k: 100 });
    expect(rgbToCmyk(255, 128, 0)).toEqual({ c: 0, m: 49.8, y: 100, k: 0 });
  });
});

describe("swatch persistence", () => {
  it("round trips independent slots and swatches without mutation", () => {
    const map = new Map<string, string>();
    const storage: SwatchStorage = { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); } };
    const empty = loadCustomSwatches(storage);
    const first = setCustomSwatchSlot(empty, 1, 1, "#ABC");
    const second = setCustomSwatchSlot(first, 1, 2, "#123456");
    const third = setCustomSwatchSlot(second, 4, 1, "fff");
    expect(empty[1]).toEqual({});
    expect(first[1]).toEqual({ slot1: "#aabbcc" });
    const cleared = clearCustomSwatchSlot(third, 1, 1);
    expect(third[1]).toEqual({ slot1: "#aabbcc", slot2: "#123456" });
    saveCustomSwatches(cleared, storage);
    expect(map.has("chemdraft.customColorSwatches.v1")).toBe(true);
    expect(loadCustomSwatches(storage)).toEqual({ 1: { slot2: "#123456" }, 2: {}, 3: {}, 4: { slot1: "#ffffff" } });
    expect(() => setCustomSwatchSlot(empty, 1, 1, "bad!")).toThrow('Hex color must be 3 or 6 hex digits, got "bad!"');
  });
  it("ignores corrupt data per slot and handles storage exceptions", () => {
    let raw = "{";
    const storage: SwatchStorage = { getItem: () => raw, setItem: () => {} };
    const empty = { 1: {}, 2: {}, 3: {}, 4: {} };
    expect(loadCustomSwatches(storage)).toEqual(empty);
    raw = JSON.stringify({ 1: { slot1: "no", slot2: "#ABC" }, 2: { slot1: 42 }, 3: null, 4: { slot1: "123456" } });
    expect(loadCustomSwatches(storage)).toEqual({ 1: { slot2: "#aabbcc" }, 2: {}, 3: {}, 4: { slot1: "#123456" } });
    const throwing: SwatchStorage = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(loadCustomSwatches(throwing)).toEqual(empty);
    expect(() => saveCustomSwatches(empty, throwing)).not.toThrow();
  });
});
