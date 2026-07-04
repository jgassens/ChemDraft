import {
  ChemDraftSyntheticStylePreset,
  type ChemDraftStylePreset,
  type CompatibilityWarning,
  type NativeDrawingStyle
} from "@chemdraft/chem-core";

export interface ChemDrawStyleSheetSourceMetadata {
  format: "chemdraw-cds";
  applicationVersion?: string;
  name?: string;
  fontFamily?: string;
  decodedFields: readonly string[];
  strings: readonly string[];
}

export interface ChemDrawStyleSheetImportResult {
  preset: ChemDraftStylePreset;
  source: ChemDrawStyleSheetSourceMetadata;
  warnings: CompatibilityWarning[];
}

export function importChemDrawStyleSheet(input: Uint8Array | ArrayBuffer | string): ChemDrawStyleSheetImportResult {
  const bytes = bytesFromInput(input);
  if (!hasChemDrawStyleHeader(bytes)) {
    throw new Error("Unsupported style sheet: expected a ChemDraw .cds header.");
  }

  const strings = printableStrings(bytes);
  const applicationVersion = strings.find((value) => /^ChemDraw\b/.test(value));
  const name = strings.find((value) => /\.cds$/i.test(value));
  const fontFamily = strings.find((value) =>
    value !== "VjCD0100" &&
    value !== applicationVersion &&
    value !== name &&
    /^[A-Za-z][A-Za-z0-9 ._-]{1,40}$/.test(value)
  );
  const decoded = decodeChemDrawStyleProperties(bytes);
  const drawing = {
    ...ChemDraftSyntheticStylePreset.drawing,
    ...decoded.patch,
    atomLabelFontFamily: fontStackFromStyleSheet(fontFamily)
  };
  const preset = {
    id: `imported.chemdraw-cds.${slugFromName(name ?? "style")}`,
    name: name?.replace(/\.cds$/i, "") ?? "Imported ChemDraw Style",
    source: "imported",
    sourceFormat: "chemdraw-cds",
    sourceName: name,
    applicationVersion,
    drawing: {
      ...drawing,
      stylePresetId: `imported.chemdraw-cds.${slugFromName(name ?? "style")}`
    }
  } satisfies ChemDraftStylePreset;

  return {
    preset,
    source: {
      format: "chemdraw-cds",
      applicationVersion,
      name,
      fontFamily,
      decodedFields: decoded.decodedFields,
      strings
    },
    warnings: chemDrawStyleSheetWarnings(decoded.decodedFields)
  };
}

function bytesFromInput(input: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof input === "string") {
    return new TextEncoder().encode(input);
  }
  if (input instanceof Uint8Array) {
    return input;
  }

  return new Uint8Array(input);
}

function hasChemDrawStyleHeader(bytes: Uint8Array): boolean {
  const header = new TextDecoder("ascii").decode(bytes.slice(0, 8));
  return header === "VjCD0100";
}

type CdxProperty = {
  tag: number;
  data: Uint8Array;
};

type NativeDrawingStyleImportPatch = Partial<
  Pick<
    NativeDrawingStyle,
    | "chainAngleDegrees"
    | "bondLengthPx"
    | "bondStrokeWidthPx"
    | "bondBoldWidthPx"
    | "bondSpacingPercent"
    | "multipleBondGapPx"
    | "bondMarginWidthPx"
    | "bondHashSpacingPx"
  >
>;

const cdxStylePropertyTags = {
  chainAngleDegrees: 0x0803,
  bondSpacingPercentTenths: 0x0804,
  bondLengthPoints: 0x0805,
  bondBoldWidthInternal: 0x0806,
  bondStrokeWidthInternal: 0x0807,
  bondMarginWidthPoints: 0x0808,
  bondHashSpacingPoints: 0x0809,
  multipleBondGapTenths: 0x0816
} as const;

const supportedCdxStyleLengths = new Map<number, readonly number[]>([
  [cdxStylePropertyTags.chainAngleDegrees, [4]],
  [cdxStylePropertyTags.bondSpacingPercentTenths, [2]],
  [cdxStylePropertyTags.bondLengthPoints, [4]],
  [cdxStylePropertyTags.bondBoldWidthInternal, [4]],
  [cdxStylePropertyTags.bondStrokeWidthInternal, [4]],
  [cdxStylePropertyTags.bondMarginWidthPoints, [4]],
  [cdxStylePropertyTags.bondHashSpacingPoints, [4]],
  [cdxStylePropertyTags.multipleBondGapTenths, [4]]
]);

const drawingDefaults = ChemDraftSyntheticStylePreset.drawing;

// ChemDraw 10 .cds stores several drawing values in fixed-point point-like
// units. The ChemDraft model stores CSS-pixel drawing values, so imported
// values are scaled against the default ChemDraw style sheet values that
// ChemDraft's synthetic preset mirrors.
const chemDrawStyleScales = {
  bondLengthPx: drawingDefaults.bondLengthPx / 14.4,
  bondStrokeWidthPx: drawingDefaults.bondStrokeWidthPx / 1.13385009765625,
  bondBoldWidthPx: drawingDefaults.bondBoldWidthPx / 2.2677154541015625,
  multipleBondGapPx: drawingDefaults.multipleBondGapPx / 35.99998474121094,
  bondMarginWidthPx: drawingDefaults.bondMarginWidthPx / 1.5999908447265625,
  bondHashSpacingPx: drawingDefaults.bondHashSpacingPx / 2.5
} as const;

function decodeChemDrawStyleProperties(bytes: Uint8Array): {
  patch: NativeDrawingStyleImportPatch;
  decodedFields: string[];
} {
  const properties = scanCdxStyleProperties(bytes);
  const patch: NativeDrawingStyleImportPatch = {};
  const decodedFields: string[] = [];

  const setNumber = <TKey extends keyof NativeDrawingStyleImportPatch>(
    key: TKey,
    value: number | undefined
  ) => {
    if (value === undefined || !Number.isFinite(value) || value < 0) {
      return;
    }
    patch[key] = roundStyleNumber(value) as NativeDrawingStyleImportPatch[TKey];
    decodedFields.push(key);
  };

  setNumber(
    "chainAngleDegrees",
    fixed16Property(properties, cdxStylePropertyTags.chainAngleDegrees)
  );
  setNumber(
    "bondLengthPx",
    scaleValue(fixed16Property(properties, cdxStylePropertyTags.bondLengthPoints), chemDrawStyleScales.bondLengthPx)
  );
  setNumber(
    "bondStrokeWidthPx",
    scaleValue(
      fixed16Property(properties, cdxStylePropertyTags.bondStrokeWidthInternal),
      chemDrawStyleScales.bondStrokeWidthPx
    )
  );
  setNumber(
    "bondBoldWidthPx",
    scaleValue(
      fixed16Property(properties, cdxStylePropertyTags.bondBoldWidthInternal),
      chemDrawStyleScales.bondBoldWidthPx
    )
  );
  setNumber(
    "bondSpacingPercent",
    scaleValue(uint16Property(properties, cdxStylePropertyTags.bondSpacingPercentTenths), 0.1)
  );
  setNumber(
    "multipleBondGapPx",
    scaleValue(
      fixed16Property(properties, cdxStylePropertyTags.multipleBondGapTenths),
      chemDrawStyleScales.multipleBondGapPx
    )
  );
  setNumber(
    "bondMarginWidthPx",
    scaleValue(fixed16Property(properties, cdxStylePropertyTags.bondMarginWidthPoints), chemDrawStyleScales.bondMarginWidthPx)
  );
  setNumber(
    "bondHashSpacingPx",
    scaleValue(fixed16Property(properties, cdxStylePropertyTags.bondHashSpacingPoints), chemDrawStyleScales.bondHashSpacingPx)
  );

  return {
    patch,
    decodedFields: [...new Set(decodedFields)]
  };
}

function scanCdxStyleProperties(bytes: Uint8Array): CdxProperty[] {
  const properties: CdxProperty[] = [];
  for (let offset = 12; offset <= bytes.length - 4; offset += 1) {
    const tag = uint16At(bytes, offset);
    const expectedLengths = supportedCdxStyleLengths.get(tag);
    if (!expectedLengths) {
      continue;
    }
    const length = uint16At(bytes, offset + 2);
    if (!expectedLengths.includes(length) || offset + 4 + length > bytes.length) {
      continue;
    }
    properties.push({
      tag,
      data: bytes.slice(offset + 4, offset + 4 + length)
    });
    offset += 3 + length;
  }
  return properties;
}

function fixed16Property(properties: readonly CdxProperty[], tag: number): number | undefined {
  const property = properties.find((candidate) => candidate.tag === tag && candidate.data.length === 4);
  if (!property) {
    return undefined;
  }
  return uint32At(property.data, 0) / 65536;
}

function uint16Property(properties: readonly CdxProperty[], tag: number): number | undefined {
  const property = properties.find((candidate) => candidate.tag === tag && candidate.data.length === 2);
  return property ? uint16At(property.data, 0) : undefined;
}

function scaleValue(value: number | undefined, scale: number): number | undefined {
  return value === undefined ? undefined : value * scale;
}

function roundStyleNumber(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function uint16At(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | ((bytes[offset + 1] ?? 0) << 8);
}

function uint32At(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

function chemDrawStyleSheetWarnings(decodedFields: readonly string[]): CompatibilityWarning[] {
  return [{
    code: decodedFields.length > 0 ? "style.cds.binary_subset_decode" : "style.cds.partial_binary_decode",
    message: decodedFields.length > 0
      ? "Imported supported ChemDraw style-sheet drawing fields; unsupported binary .cds settings were ignored."
      : "Imported ChemDraw style-sheet identity/font metadata and applied ChemDraft-supported drawing defaults; unsupported binary .cds settings were not decoded."
  }];
}

function printableStrings(bytes: Uint8Array): readonly string[] {
  const values: string[] = [];
  let current = "";

  bytes.forEach((byte) => {
    if (byte >= 32 && byte <= 126) {
      current += String.fromCharCode(byte);
      return;
    }

    if (current.length >= 3) {
      values.push(current);
    }
    current = "";
  });

  if (current.length >= 3) {
    values.push(current);
  }

  return [...new Set(values)];
}

function slugFromName(name: string): string {
  const slug = name
    .replace(/\.cds$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "style";
}

function fontStackFromStyleSheet(fontFamily: string | undefined): string {
  if (!fontFamily || fontFamily.toLowerCase() === "arial") {
    return ChemDraftSyntheticStylePreset.drawing.atomLabelFontFamily;
  }

  return `${fontFamily}, ${ChemDraftSyntheticStylePreset.drawing.atomLabelFontFamily}`;
}
