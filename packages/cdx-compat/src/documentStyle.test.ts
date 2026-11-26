import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createEmptyDocument, DefaultNativeTextStyle, nativeTextStyleFromObjectStyle, parseDocument, type TableObject, type TextObject } from "@chemdraft/chem-core";
import {
  cdxmlDocumentStyleFontNames,
  cdxmlDocumentStyleHeader,
  exportDocumentToCdxml,
  nativeDrawingStyleFromCdxmlStyle,
  openChemDraftPayload,
  readCdxmlDocumentStyle
} from "./index";

/** A synthetic reference shaped like a document-style CDXML file: root settings, a font table,
 *  and a page whose content the style reader ignores. */
function referenceCdxml(rootAttributes: string, fontTable = '<fonttable><font id="21" charset="x-mac-roman" name="Helvetica"/></fonttable>'): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" ?>',
    '<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd" >',
    `<CDXML CreationProgram="Reference" ${rootAttributes}>`,
    "<colortable><color r=\"1\" g=\"1\" b=\"1\"/><color r=\"0\" g=\"0\" b=\"0\"/></colortable>",
    fontTable,
    '<page id="1"><fragment id="2"><n id="3" p="10 10"/></fragment></page>',
    "</CDXML>"
  ].join("\n");
}

const documentStyleAttributes = [
  'LabelFont="21" LabelSize="10" LabelFace="96" CaptionFont="21" CaptionSize="10"',
  'HashSpacing="2.83" MarginWidth="1" LineWidth="0.90" BoldWidth="2" BondLength="14.40"',
  'BondSpacing="14" ChainAngle="120"'
].join(" ");

describe("readCdxmlDocumentStyle", () => {
  it("reads every root drawing setting and resolves fonts through the font table", () => {
    const { style, missing } = readCdxmlDocumentStyle(referenceCdxml(documentStyleAttributes));
    expect(style).toEqual({
      bondLengthPt: 14.4,
      lineWidthPt: 0.9,
      boldWidthPt: 2,
      hashSpacingPt: 2.83,
      marginWidthPt: 1,
      bondSpacingPercent: 14,
      chainAngleDegrees: 120,
      labelFontName: "Helvetica",
      labelSizePt: 10,
      labelFace: 96,
      captionFontName: "Helvetica",
      captionSizePt: 10
    });
    // CaptionFace is unset, but captions never decide a structure drawing, so it is not reported.
    expect(missing).toEqual([]);
  });

  it("reports structure settings the reference leaves unset instead of inventing them", () => {
    const { style, missing } = readCdxmlDocumentStyle(referenceCdxml('BondLength="14.4"', ""));
    expect(style).toEqual({ bondLengthPt: 14.4 });
    expect(missing).toEqual([
      "LineWidth", "BoldWidth", "HashSpacing", "MarginWidth", "BondSpacing", "ChainAngle",
      "LabelSize", "LabelFace", "LabelFont"
    ]);
  });

  it("reads the style when a ChemDraft payload contains a long attribute", () => {
    const contents = `<CDXML BondLength="14.4"><objecttag Value="${"A".repeat(500_000)}"/></CDXML>`;
    expect(readCdxmlDocumentStyle(contents).style).toEqual({ bondLengthPt: 14.4 });
  });

  it("decodes predefined XML references without expanding a document-defined entity", () => {
    expect(readCdxmlDocumentStyle('<CDXML BondLength="14&#46;4"/>').style).toEqual({ bondLengthPt: 14.4 });
    const contents = '<!DOCTYPE CDXML [<!ENTITY length "14.4">]><CDXML BondLength="&length;"/>';
    expect(() => readCdxmlDocumentStyle(contents)).toThrow('BondLength="&length;" is not a usable value');
  });

  it("rejects a referenced font entry that exceeds the CDXML import limit", () => {
    const fonts = `<fonttable><font id="21" name="Helvetica" padding="${"a".repeat(512)}"/></fonttable>`;
    expect(() => readCdxmlDocumentStyle(referenceCdxml('LabelFont="21"', fonts)))
      .toThrow("LabelFont font entry exceeds the CDXML import size limit");
  });

  it.each([
    ["a file that is not XML", "not xml <<<", "not well-formed XML"],
    ["XML that is not CDXML", '<?xml version="1.0"?><svg/>', "no top-level <CDXML> element"],
    ["a non-numeric bond length", referenceCdxml('BondLength="long"'), 'BondLength="long" is not a usable value'],
    ["an out-of-range line width", referenceCdxml('LineWidth="0"'), 'LineWidth="0" is not a usable value'],
    ["a fractional face", referenceCdxml('LabelFace="1.5"'), 'LabelFace="1.5" is not a usable value'],
    ["a font id missing from the table", referenceCdxml('LabelFont="99"'), 'LabelFont="99" names no font'],
    [
      "a font name that is not plain",
      referenceCdxml('LabelFont="21"', '<fonttable><font id="21" name="Evil; font-size: 99px"/></fonttable>'),
      "is not a plain font name"
    ]
  ])("refuses %s and names the reason", (_name, contents, reason) => {
    expect(() => readCdxmlDocumentStyle(contents)).toThrow(reason);
  });
});

describe("nativeDrawingStyleFromCdxmlStyle", () => {
  it("converts points to native CSS pixels at the CDXML writer's 72/96 ratio", () => {
    const { style } = readCdxmlDocumentStyle(referenceCdxml(documentStyleAttributes));
    expect(nativeDrawingStyleFromCdxmlStyle(style)).toEqual({
      bondLengthPx: 19.2,
      bondStrokeWidthPx: 1.2,
      bondBoldWidthPx: 2.6667,
      bondHashSpacingPx: 3.7733,
      bondMarginWidthPx: 1.3333,
      chainAngleDegrees: 120,
      bondSpacingMode: "percent",
      bondSpacingPercent: 14,
      multipleBondGapPx: 2.688,
      atomLabelFontFamily: "Helvetica, Arial, sans-serif",
      atomLabelFontSizePx: 13.3333,
      atomLabelFontWeight: 400,
      atomLabelFontStyle: "normal"
    });
  });

  it("maps the bold and italic face bits onto the label font", () => {
    expect(nativeDrawingStyleFromCdxmlStyle({ labelFace: 3 })).toEqual({
      atomLabelFontWeight: 700,
      atomLabelFontStyle: "italic"
    });
  });
});

describe("CDXML export with a document style", () => {
  it("declares the settings on the root element and shares one font-table entry", () => {
    const { style } = readCdxmlDocumentStyle(referenceCdxml(documentStyleAttributes));
    expect(cdxmlDocumentStyleFontNames(style)).toEqual(["Helvetica"]);
    const header = cdxmlDocumentStyleHeader(style, (name) => name === "Helvetica" ? "3" : undefined);
    expect(header.attributes).toEqual({
      LabelFont: "3", LabelSize: "10", LabelFace: "96", CaptionFont: "3", CaptionSize: "10", HashSpacing: "2.83",
      MarginWidth: "1", LineWidth: "0.9", BoldWidth: "2", BondLength: "14.4", BondSpacing: "14", ChainAngle: "120"
    });
    expect(Object.keys(header.attributes)).toEqual([
      "LabelFont", "LabelSize", "LabelFace", "CaptionFont", "CaptionSize", "HashSpacing",
      "MarginWidth", "LineWidth", "BoldWidth", "BondLength", "BondSpacing", "ChainAngle"
    ]);

    const { contents } = exportDocumentToCdxml(createEmptyDocument({ title: "styled" }), { documentStyle: style });
    const fontTable = contents.match(/<fonttable>[\s\S]*?<\/fonttable>/g);
    expect(fontTable).toHaveLength(1);
    expect(fontTable![0]!.match(/<font /g)).toHaveLength(1);
    const id = /<font id="(\d+)" charset="iso-8859-1" name="Helvetica"\/>/.exec(fontTable![0]!)?.[1];
    expect(id).toBeDefined();
    expect(contents).toContain(`LabelFont="${id}"`);
    expect(contents).toContain(`CaptionFont="${id}"`);
  });

  it("escapes a font name supplied directly by a caller", () => {
    const { contents } = exportDocumentToCdxml(createEmptyDocument({ title: "escaped" }), { documentStyle: { labelFontName: 'A"B<C' } });
    expect(contents).toContain('name="A&quot;B&lt;C"');
  });

  it("writes a file the style reader reads back and ChemDraft reopens as its own", () => {
    const { style } = readCdxmlDocumentStyle(referenceCdxml(documentStyleAttributes));
    const document = createEmptyDocument({ title: "styled" });
    const { contents } = exportDocumentToCdxml(document, { documentStyle: style });

    expect(readCdxmlDocumentStyle(contents).style).toEqual(style);
    const reopened = openChemDraftPayload(contents);
    expect(reopened.source).toBe("native-payload");
    expect(reopened.conflict).toBeUndefined();
    expect(reopened.warnings).toEqual([]);
  });

  it("leaves the root element unchanged when no style is given", () => {
    const { contents } = exportDocumentToCdxml(createEmptyDocument({ title: "plain" }));
    expect(contents).toMatch(/<CDXML CreationProgram="ChemDraft"[^>]*>/);
    expect(contents).not.toMatch(/<CDXML [^>]*(?:LabelFont|BondLength)=/);
    expect(contents).not.toContain("<fonttable>");
  });
});

describe("CDXML export: every table font= id is in the one font table", () => {
  const sharplessTable = () => {
    const fixture = parseDocument(JSON.parse(readFileSync(new URL("../../fixtures/tables/sharpless-reagent-table.json", import.meta.url), "utf8")));
    return fixture.pages[0]!.objects.find(object => object.type === "table") as TableObject;
  };
  const documentWith = (sourceFonts: Record<string, string>[], tableFont?: string) => {
    const document = createEmptyDocument({ title: "table fonts" });
    const holder: TextObject = { type: "text", id: "holder", x: 10, y: 10, width: 40, height: 22, rotation: 0, text: "h", spans: [],
      style: {}, compatibility: { warnings: [], unknown: { cdxmlTextFontTable: sourceFonts } } };
    const source = sharplessTable();
    const table: TableObject = tableFont === undefined ? source : { ...source, style: { ...source.style, fontFamily: tableFont } };
    document.pages[0].objects = [holder, table];
    return document;
  };
  const fontIdsAndNames = (contents: string) => {
    const tables = contents.match(/<fonttable>[\s\S]*?<\/fonttable>/g) ?? [];
    expect(tables).toHaveLength(1);
    const listed = new Map([...tables[0]!.matchAll(/<font id="(\d+)"[^>]*name="([^"]*)"/g)].map(match => [match[1]!, match[2]!]));
    const used = new Set([...contents.matchAll(/<s font="([^"]*)"/g)].map(match => match[1]!));
    expect(used.size).toBeGreaterThan(0);
    return { listed, used };
  };
  const plain = { embedNativePayload: false };
  const smallSource = [{ id: "2", charset: "iso-8859-1", name: "Times" }, { id: "3", charset: "iso-8859-1", name: "Courier" }];

  it.each([
    ["no document style", undefined],
    ["a partial document style with no fonts", { bondLengthPt: 14.4 }]
  ])("lists the table's font beside a source table using ids 2 and up, with %s", (_name, documentStyle) => {
    const { contents } = exportDocumentToCdxml(documentWith(smallSource), { ...plain, ...(documentStyle ? { documentStyle } : {}) });
    const { listed, used } = fontIdsAndNames(contents);
    const tableFont = nativeTextStyleFromObjectStyle(sharplessTable().style).fontFamily;
    for (const id of used) expect(listed.get(id), `font="${id}"`).toBe(tableFont);
  });

  // A full table: id 1 is reserved by a stored font too long to write, ids 2 to 65,534 are taken,
  // and the default font is among them. The table's own font cannot be added, so it is written in
  // the default font at the id the table lists it under, never at an assumed id 1.
  const fullSource = () => [
    { id: "1", charset: "iso-8859-1", name: "L".repeat(1_000) },
    ...Array.from({ length: 65_533 }, (_, index) => {
      const id = index + 2;
      return { id: String(id), charset: "iso-8859-1", name: id === 40_000 ? DefaultNativeTextStyle.fontFamily : `Font${id}` };
    })
  ];

  it.each([
    ["no document style", undefined],
    ["a partial document style with no fonts", { bondLengthPt: 14.4 }]
  ])("writes a table whose font cannot be added in the listed default font, with %s", (_name, documentStyle) => {
    const { contents } = exportDocumentToCdxml(documentWith(fullSource(), "Palatino"), { ...plain, ...(documentStyle ? { documentStyle } : {}) });
    const { listed, used } = fontIdsAndNames(contents);
    expect(listed.has("1")).toBe(false);
    expect([...used]).toEqual(["40000"]);
    expect(listed.get("40000")).toBe(DefaultNativeTextStyle.fontFamily);
  }, 60_000);

  it("names the default font in a warning when a table whose font cannot be added falls back to it", () => {
    const { warnings } = exportDocumentToCdxml(documentWith(fullSource(), "Palatino"), plain);
    const fallback = warnings.filter(w => w.code === "cdxml.table_font_fallback");
    expect(fallback).toHaveLength(1);
    expect(fallback[0]!.message).toContain(`in the default font "${DefaultNativeTextStyle.fontFamily}"`);
    expect(warnings.map(w => w.code)).toContain("cdxml.font_table_full");
  }, 60_000);

  it("names the first listed font in a warning when the default font is not listed either", () => {
    const source = fullSource().map(font => font.id === "40000" ? { ...font, name: "Font40000" } : font);
    const { contents, warnings } = exportDocumentToCdxml(documentWith(source, "Palatino"), plain);
    const { listed, used } = fontIdsAndNames(contents);
    const firstListed = [...listed.values()][0]!;
    const fallback = warnings.filter(w => w.code === "cdxml.table_font_fallback");
    expect(fallback).toHaveLength(1);
    expect(fallback[0]!.message).toContain(`in the first listed font "${firstListed}"`);
    expect(fallback[0]!.message).not.toContain("in the default font");
    expect(listed.get([...used][0]!)).toBe(firstListed);
  }, 60_000);

  it("never points a table at a font id the table does not list when the default font is absent too", () => {
    const source = fullSource().map(font => font.id === "40000" ? { ...font, name: "Font40000" } : font);
    const { contents } = exportDocumentToCdxml(documentWith(source, "Palatino"), { ...plain, documentStyle: { labelFontName: "Helvetica" } });
    const { listed, used } = fontIdsAndNames(contents);
    for (const id of used) expect(listed.has(id), `font="${id}" is listed`).toBe(true);
    expect(contents).not.toMatch(/LabelFont=/);
  }, 60_000);
});

describe("style reference font names beyond ASCII", () => {
  const withLabelFont = (name: string) => referenceCdxml('LabelFont="21"', `<fonttable><font id="21" charset="utf-8" name="${name}"/></fonttable>`);

  it.each(["游ゴシック", "ヒラギノ角ゴ ProN W3", "ＭＳ Ｐゴシック", "Linux Libertine Ö", "Noto Sans CJK JP"])("accepts the font name %s", (name) => {
    expect(readCdxmlDocumentStyle(withLabelFont(name)).style.labelFontName).toBe(name);
  });

  it("round-trips a Japanese label font through export and re-import", () => {
    const { style } = readCdxmlDocumentStyle(referenceCdxml(
      documentStyleAttributes.replace('CaptionFont="21"', 'CaptionFont="22"'),
      '<fonttable><font id="21" charset="utf-8" name="游ゴシック"/><font id="22" charset="utf-8" name="ヒラギノ角ゴ ProN W3"/></fonttable>'
    ));
    expect(style.labelFontName).toBe("游ゴシック");
    expect(nativeDrawingStyleFromCdxmlStyle(style).atomLabelFontFamily).toBe("游ゴシック, Arial, Helvetica, sans-serif");
    const { contents } = exportDocumentToCdxml(createEmptyDocument({ title: "japanese" }), { documentStyle: style });
    expect(readCdxmlDocumentStyle(contents).style).toEqual(style);
    const reopened = openChemDraftPayload(contents);
    expect(reopened.source).toBe("native-payload");
    expect(reopened.warnings).toEqual([]);
  });

  it.each([
    ["a control character (tab)", "Font&#9;Name"],
    ["a C1 control character", "Font\u0085Name"],
    ["a line break", "Font&#10;Name"],
    ["a bidirectional override", "Font‮Name"],
    ["a zero-width joiner", "Font‍Name"],
    ["a CSS separator", "Font, Evil"],
    ["a CSS declaration", "Font;color:red"],
    ["a quote", "Font&quot;Name"],
    ["markup", "Font&lt;b&gt;"],
    ["a backslash", "Font\\Name"],
    ["a leading space", " Font"],
    ["a name over 64 characters", "字".repeat(65)]
  ])("still refuses a font name with %s", (_name, name) => {
    expect(() => readCdxmlDocumentStyle(withLabelFont(name))).toThrow("is not a plain font name");
  });
});
