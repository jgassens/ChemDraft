import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "@chemdraft/chem-core";
import {
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
    const header = cdxmlDocumentStyleHeader(style);
    expect(header.attributes).toBe(
      ' LabelFont="3" LabelSize="10" LabelFace="96" CaptionFont="3" CaptionSize="10" HashSpacing="2.83"' +
      ' MarginWidth="1" LineWidth="0.9" BoldWidth="2" BondLength="14.4" BondSpacing="14" ChainAngle="120"'
    );
    expect(header.fontTable).toContain('<font id="3" charset="iso-8859-1" name="Helvetica"/>');
    expect(header.fontTable.match(/<font /g)).toHaveLength(1);
  });

  it("escapes a font name supplied directly by a caller", () => {
    expect(cdxmlDocumentStyleHeader({ labelFontName: 'A"B<C' }).fontTable).toContain('name="A&quot;B&lt;C"');
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
    expect(contents).toContain('<CDXML CreationProgram="ChemDraft">');
    expect(contents).not.toContain("<fonttable>");
  });
});
