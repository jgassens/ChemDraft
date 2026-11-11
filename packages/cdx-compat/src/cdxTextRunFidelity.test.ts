import { describe, expect, it } from "vitest";
import type { TextObject } from "@chemdraft/chem-core";
import { exportDocumentToCdx, exportDocumentToCdxml, importCdx, openChemDraftPayload } from "./index";

// Entirely synthetic. CDXML face bit 32 means subscript; 64 means superscript.
const source = `<CDXML><colortable>
  <color r="1" g="1" b="1"/><color r="0" g="0" b="0"/><color r="1" g="0" b="0"/>
</colortable><page id="1" BoundingBox="0 0 612 792">
  <t id="2" p="30 40">A<s face="32">2</s><s face="64">2</s><s face="64" color="3"></s><s>plain é</s><s color="4">red</s><s color="3">black</s>tail</t>
</page></CDXML>`;

function textOf(result: ReturnType<typeof openChemDraftPayload>): TextObject {
  expect(result.document, JSON.stringify(result.warnings)).toBeDefined();
  const objects = result.document!.pages[0]!.objects;
  expect(objects).toHaveLength(1);
  expect(objects[0]!.type).toBe("text");
  return objects[0] as TextObject;
}

describe("payload-less text run fidelity", () => {
  const nonEmptyCases: { name: string; faces: number[]; spans: TextObject["spans"] }[] = [
    { name: "CO with subscript 2", faces: [0, 32], spans: [
      { text: "CO", script: "normal", style: { color: "#ff0000" } },
      { text: "2", script: "subscript", style: { color: "#ff0000" } }
    ] },
    { name: "m with superscript 2", faces: [0, 64], spans: [
      { text: "m", script: "normal", style: { color: "#ff0000" } },
      { text: "2", script: "superscript", style: { color: "#ff0000" } }
    ] },
    { name: "superscript charge +", faces: [64], spans: [
      { text: "+", script: "superscript", style: { color: "#ff0000" } }
    ] },
    { name: "mixed bold and italic", faces: [1, 2, 3, 0], spans: [
      { text: "bold", script: "normal", style: { color: "#ff0000", fontWeight: 700 } },
      { text: "italic", script: "normal", style: { color: "#ff0000", fontStyle: "italic" } },
      { text: "both", script: "normal", style: { color: "#ff0000", fontWeight: 700, fontStyle: "italic" } },
      { text: "plain", script: "normal", style: { color: "#ff0000" } }
    ] }
  ];
  for (const format of ["CDXML", "CDX"] as const) {
    for (const { name, faces, spans } of nonEmptyCases) {
      for (const preserveSource of [true, false]) {
        it(`keeps non-empty ${name} through ${format} (${preserveSource ? "source" : "native"} runs)`, () => {
          const xml = `<CDXML><colortable><color r="1" g="0" b="0"/></colortable>
            <page id="1"><t id="2" p="30 40">${spans.map((span, i) =>
              `<s face="${faces[i]}" color="2">${span.text}</s>`).join("")}</t></page></CDXML>`;
          const imported = openChemDraftPayload(xml);
          const original = textOf(imported);
          if (preserveSource) {
            // Assert the intended style too: a lossy initial import must not become our baseline.
            expect(original.spans).toEqual(spans);
          } else {
            // Exercise the native writer independently of preserved source formatting.
            delete original.compatibility;
            original.spans = structuredClone(spans);
          }
          const exported = format === "CDX"
            ? exportDocumentToCdx(imported.document!, { embedNativePayload: false })
            : exportDocumentToCdxml(imported.document!, { embedNativePayload: false });
          const reopened = "bytes" in exported ? importCdx(exported.bytes) : openChemDraftPayload(exported.contents);
          expect(textOf(reopened).spans).toEqual(spans);
          expect(textOf(reopened).text).toBe(spans.map(span => span.text).join(""));
          expect(exported.warnings).toEqual([]);
          expect(reopened.warnings.map(warning => warning.code)).toEqual(["cdxml.external_subset_imported"]);
        });
      }
    }
  }

  for (const format of ["CDXML", "CDX"] as const) {
    for (const explicitColors of [false, true]) {
      it(`preserves scripts and lengths through ${format} (all colours explicit: ${explicitColors})`, () => {
        // A second variant has no inherited colours, so full native run equality is representable
        // in both formats. Keep explicit black distinct from absent colour in the first variant.
        const xml = explicitColors ? source.replace('>A<s', '><s color="3">A</s><s')
          .replace(/<s(?![^>]*color=)([^>]*)>/g, '<s color="3"$1>')
          .replace('tail</t>', '<s color="3">tail</s></t>') : source;
        const imported = openChemDraftPayload(xml);
        const original = textOf(imported);
        expect(original.spans.map(span => span.script)).toEqual([
          "normal", "subscript", "superscript", "superscript", "normal", "normal", "normal", "normal"
        ]);
        expect(original.spans.map(span => Object.hasOwn(span.style, "color")))
          .toEqual(explicitColors ? Array(8).fill(true) : [false, false, false, true, false, true, true, false]);
        const exported = format === "CDX"
          ? exportDocumentToCdx(imported.document!, { embedNativePayload: false })
          : exportDocumentToCdxml(imported.document!, { embedNativePayload: false });
        const reopened = "bytes" in exported ? importCdx(exported.bytes) : openChemDraftPayload(exported.contents);
        const actual = textOf(reopened);
        // Length is derived from each native span's text, not a separate schema field.
        const runs = (text: TextObject) => text.spans.map(span =>
          ({ text: span.text, script: span.script, length: span.text.length }));
        expect(runs(actual)).toEqual(runs(original));
        expect(actual.text).toBe(original.text);
        if (format === "CDX" && !explicitColors) {
          // CDX requires a colour in every style record: absence cannot survive standard CDX.
          // Explicit inherited/default colour draws identically, so it needs no warning.
          expect(actual.spans).toEqual(original.spans.map(span => ({
            ...span, style: { ...span.style, color: span.style.color ?? "#000000" }
          })));
        } else {
          expect(actual.spans).toEqual(original.spans);
        }
        expect(exported.warnings).toEqual([]);
        expect(reopened.warnings.map(warning => warning.code)).toEqual(["cdxml.external_subset_imported"]);
      });
    }
  }

  it("materializes the parent colour while keeping an explicit black override", () => {
    const imported = openChemDraftPayload(source.replace('p="30 40"', 'p="30 40" color="4"'));
    const original = textOf(imported);
    const exported = exportDocumentToCdx(imported.document!, { embedNativePayload: false });
    const reopened = importCdx(exported.bytes);
    const actual = textOf(reopened);
    const effectiveColors = (text: TextObject) => text.spans.map(span =>
      span.style.color ?? text.style.color ?? "#000000");
    expect(original.style.color).toBe("#ff0000");
    expect(effectiveColors(actual)).toEqual(effectiveColors(original));
    expect(actual.spans.map(span => Object.hasOwn(span.style, "color"))).toEqual(Array(8).fill(true));
    expect(exported.warnings).toEqual([]);
    expect(reopened.warnings.map(warning => warning.code)).toEqual(["cdxml.external_subset_imported"]);
  });
});
