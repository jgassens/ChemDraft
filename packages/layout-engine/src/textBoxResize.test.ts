import { describe, expect, it } from "vitest";
import { createEmptyDocument, nativeTextStyleFromObjectStyle, type TextObject, type TextSpan } from "@chemdraft/chem-core";
import { planPageSvgRender, type PageSvgElementFragment } from "./index";
import { estimateNativeTextLineWidth, nativeTextSpanLines } from "./textLayout";

describe("resized text box rendering", () => {
  it("wraps the finished SVG text to the resized box width", () => {
    const object: TextObject = {
      id: "text_resize", type: "text", x: 100, y: 100, width: 80, height: 200,
      rotation: 0, style: { textBoxSizingMode: "fixed-width", fontSizePx: 18 },
      text: "reaction conditions and temperature", spans: []
    };
    const page = { ...createEmptyDocument().pages[0]!, objects: [object] };
    const text = planPageSvgRender(page).fragments.find(fragment => fragment.tag === "text")!;
    const lines = text.children.filter((child): child is PageSvgElementFragment => child.kind === "element");
    expect(lines.filter(line => line.attrs.x !== undefined).length).toBeGreaterThan(1);
    expect(lines.slice(1).some(line => Number(line.attrs.dy) > 0)).toBe(true);
  });
});

describe("shared text box wrapping", () => {
  const style = nativeTextStyleFromObjectStyle({ fontSizePx: 18 });
  const normal = (text: string): TextSpan => ({ text, script: "normal", style: {} });
  const content = (lines: TextSpan[][]) => lines.map(line => line.map(span => span.text).join(""));

  it("reflows back to one line when widened, without rewriting the source spans", () => {
    const spans = [normal("reaction conditions and temperature")];
    const before = structuredClone(spans);
    expect(nativeTextSpanLines(spans, style, 70).length).toBeGreaterThan(1);
    expect(content(nativeTextSpanLines(spans, style, 1000))).toEqual([spans[0]!.text]);
    expect(spans).toEqual(before);
  });

  it("splits long words and retains every character, including Unicode", () => {
    const text = "polymerizationαβ😀";
    const lines = content(nativeTextSpanLines([normal(text)], style, 40));
    expect(lines.join("")).toBe(text);
    expect(lines.every(line => estimateNativeTextLineWidth(line, style) <= 40)).toBe(true);
  });

  it("keeps word boundaries across formatting spans and preserves scripts and colors", () => {
    const spans: TextSpan[] = [normal("water "), { text: "H", script: "normal", style: { color: "#ff0000" } },
      { text: "2", script: "subscript", style: {} }, normal("O then heat")];
    const lines = nativeTextSpanLines(spans, style, 75);
    expect(content(lines).join("")).toBe(spans.map(span => span.text).join(""));
    expect(content(lines).some(line => line.includes("H2O"))).toBe(true);
    expect(lines.flat().find(span => span.text === "2")?.script).toBe("subscript");
    expect(lines.flat().find(span => span.text.includes("H"))?.style.color).toBe("#ff0000");
  });

  it("preserves blank paragraphs and Windows newlines even across spans", () => {
    expect(content(nativeTextSpanLines([normal("one\r"), normal("\n\r\ntwo\r")], style, 1000)))
      .toEqual(["one", "", "two", ""]);
  });

  it("does not add paragraph spacing at soft line breaks", () => {
    const object: TextObject = { id: "spacing", type: "text", x: 0, y: 0, width: 80, height: 400,
      rotation: 30, style: { fontSizePx: 18, lineHeight: 1.2, paragraphSpacingPx: 8,
        textAlign: "right", textBoxSizingMode: "fixed-size" },
      text: "reaction conditions\nheat", spans: [] };
    const page = { ...createEmptyDocument().pages[0]!, objects: [object] };
    const text = planPageSvgRender(page).fragments.find(fragment => fragment.tag === "text")!;
    const lines = text.children.filter((child): child is PageSvgElementFragment => child.kind === "element");
    expect(text.attrs["text-anchor"]).toBe("end");
    expect(text.attrs.transform).toContain("rotate(30");
    expect(lines.filter(line => line.attrs.dy === 18 * 1.2).length).toBeGreaterThan(0);
    expect(lines.filter(line => line.attrs.dy === 18 * 1.2 + 8)).toHaveLength(1);
  });
});
