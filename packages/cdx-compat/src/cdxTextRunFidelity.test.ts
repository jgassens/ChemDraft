import { describe, expect, it } from "vitest";
import { DefaultNativeTextStyle, type TextObject } from "@chemdraft/chem-core";
import { MAGIC } from "./cdxBinary";
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
  it("keeps the Na Cl custom run colours through visible CDXML", () => {
    const imported = openChemDraftPayload(`<CDXML><colortable>
      <color r="0.2" g="0.4" b="0.6"/><color r="0.6" g="0.2" b="0.4"/>
      </colortable><page id="1"><t id="2" p="30 40"><s color="2">Na</s> <s color="3">Cl</s></t></page></CDXML>`);
    const original = textOf(imported);
    expect(original.text).toBe("Na Cl");
    expect(original.spans).toEqual([
      { text: "Na", script: "normal", style: { color: "#336699" } },
      { text: " ", script: "normal", style: {} },
      { text: "Cl", script: "normal", style: { color: "#993366" } }
    ]);
    const exported = exportDocumentToCdxml(imported.document!, { embedNativePayload: false });
    expect(exported.contents).toContain("<colortable>");
    expect(exported.contents).toContain('<s color="2">Na</s> <s color="3">Cl</s>');
    expect(textOf(openChemDraftPayload(exported.contents)).spans).toEqual(original.spans);
    expect(exported.warnings).toEqual([]);
  });

  for (const preserveSource of [true, false]) {
    it(`keeps the Na Cl custom run colours through visible CDX (${preserveSource ? "source" : "native"} runs)`, () => {
      const imported = openChemDraftPayload(`<CDXML><colortable>
        <color r="0.2" g="0.4" b="0.6"/><color r="0.6" g="0.2" b="0.4"/>
        </colortable><page id="1"><t id="2" p="30 40"><s color="2">Na</s> <s color="3">Cl</s></t></page></CDXML>`);
      const original = textOf(imported);
      const spans = structuredClone(original.spans);
      // With the source palette, slot 3 is purple: the uncoloured space needs reserved black.
      if (preserveSource) spans[1].style.color = "#000000";
      if (!preserveSource) delete original.compatibility;
      const exported = exportDocumentToCdx(imported.document!, { embedNativePayload: false });
      expect(textOf(importCdx(exported.bytes)).spans).toEqual(spans);
      expect(exported.warnings).toEqual([]);
    });
  }

  for (const format of ["CDXML", "CDX"] as const) {
    for (const preserveSource of [true, false]) {
      it(`keeps uncoloured and explicit palette black runs distinct through ${format} (${preserveSource ? "source" : "native"} runs)`, () => {
        const imported = openChemDraftPayload(`<CDXML><colortable>
          <color r="1" g="1" b="1"/><color r="0" g="0" b="0"/>
          </colortable><page id="1"><t id="2" p="30 40"><s>default</s><s color="3">black</s></t></page></CDXML>`);
        const original = textOf(imported);
        const spans: TextObject["spans"] = [
          { text: "default", script: "normal", style: {} },
          { text: "black", script: "normal", style: { color: "#000000" } }
        ];
        expect(original.spans).toEqual(spans);
        if (!preserveSource) delete original.compatibility;
        const exported = format === "CDX"
          ? exportDocumentToCdx(imported.document!, { embedNativePayload: false })
          : exportDocumentToCdxml(imported.document!, { embedNativePayload: false });
        const reopened = "bytes" in exported ? importCdx(exported.bytes) : openChemDraftPayload(exported.contents);
        expect(textOf(reopened).spans).toEqual(spans);
        expect(exported.warnings).toEqual([]);
      });

      it(`keeps an uncoloured run black with red at source index 3 through ${format} (${preserveSource ? "source" : "native"} runs)`, () => {
        const imported = openChemDraftPayload(`<CDXML><colortable>
          <color r="1" g="1" b="1"/><color r="1" g="0" b="0"/><color r="0" g="0" b="0"/>
          </colortable><page id="1"><t id="2" p="30 40"><s>default</s><s color="4">black</s></t></page></CDXML>`);
        const original = textOf(imported);
        const spans = structuredClone(original.spans);
        // Binary CDX requires a colour: reserved black avoids the red foreground.
        if (format === "CDX" && preserveSource) spans[0].style.color = "#000000";
        if (!preserveSource) delete original.compatibility;
        const exported = format === "CDX"
          ? exportDocumentToCdx(imported.document!, { embedNativePayload: false })
          : exportDocumentToCdxml(imported.document!, { embedNativePayload: false });
        const reopened = "bytes" in exported ? importCdx(exported.bytes) : openChemDraftPayload(exported.contents);
        const actual = textOf(reopened);
        expect(actual.spans).toEqual(spans);
        expect(actual.spans[0].style.color).toBe(format === "CDX" && preserveSource ? "#000000" : undefined);
        expect(actual.spans[0].style.color ?? actual.style.color ?? DefaultNativeTextStyle.color).toBe(format === "CDX" && preserveSource ? "#000000" : "#111111");
        expect(actual.spans[1].style.color).toBe("#000000");
        expect(exported.warnings).toEqual([]);
      });
    }
  }

  it("keeps an uncoloured native run with a preserved red foreground through embedded CDX", () => {
    const imported = openChemDraftPayload(`<CDXML><colortable>
      <color r="1" g="1" b="1"/><color r="1" g="0" b="0"/>
      </colortable><page id="1"><t id="2" p="30 40"><s>default</s></t></page></CDXML>`);
    const original = textOf(imported);
    expect(original.spans[0].style).not.toHaveProperty("color");
    const exported = exportDocumentToCdx(imported.document!, { embedNativePayload: true });
    expect(textOf(importCdx(exported.bytes)).spans).toEqual(original.spans);
    const visible = exportDocumentToCdx(imported.document!, { embedNativePayload: false });
    expect(textOf(importCdx(visible.bytes)).spans[0].style.color).toBe("#000000");
    expect(exported.warnings).toEqual([]);
    expect(visible.warnings).toEqual([]);
  });

  for (const runColor of [undefined, 0, 3]) {
    it(`reads an independently built binary run colour ${runColor ?? "absent"} using its own foreground and palette`, () => {
      const u16 = (n: number) => [n & 255, n >>> 8 & 255];
      const u32 = (n: number) => [...u16(n), ...u16(n >>> 16)];
      const property = (tag: number, data: number[]) => [...u16(tag), ...u16(data.length), ...data];
      const object = (tag: number, id: number, data: number[]) => [...u16(tag), ...u32(id), ...data, 0, 0];
      const text = [...new TextEncoder().encode("test")];
      const runs = runColor === undefined ? u16(0) : [...u16(1), ...[0, 0xffff, 0, 0, runColor].flatMap(u16)];
      const bytes = new Uint8Array([
        ...new TextEncoder().encode(MAGIC), 4, 3, 2, 1, ...Array(10).fill(0),
        ...object(0x8000, 0, [
          ...object(0x8001, 1, object(0x8006, 2, property(0x0700, [...runs, ...text]))),
          // Metadata deliberately follows the text. Slot 3 resolves through the
          // file palette to red; reserved slot 0 remains explicit black.
          ...property(0x0301, u16(4)),
          ...property(0x0300, [...u16(3), ...[65535, 65535, 65535, 65535, 0, 0, 0, 0, 0].flatMap(u16)])
        ])
      ]);
      const actual = textOf(importCdx(bytes));
      expect(actual.spans).toEqual([{ text: "test", script: "normal", style: runColor === 0 ? { color: "#000000" } : runColor === 3 ? { color: "#ff0000" } : {} }]);
    });
  }

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
        // The release colour-slot contract preserves absent colour through CDX;
        // only an explicit black run acquires the reserved black index 0.
        expect(actual.spans).toEqual(original.spans);
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
