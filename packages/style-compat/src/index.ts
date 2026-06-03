import {
  ChemDraftSyntheticStylePreset,
  type ChemDraftStylePreset,
  type CompatibilityWarning
} from "@chemdraft/chem-core";

export interface ChemDrawStyleSheetSourceMetadata {
  format: "chemdraw-cds";
  applicationVersion?: string;
  name?: string;
  fontFamily?: string;
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
  const drawing = {
    ...ChemDraftSyntheticStylePreset.drawing,
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
      strings
    },
    warnings: [
      {
        code: "style.cds.partial_binary_decode",
        message: "Imported ChemDraw style-sheet identity/font metadata and applied ChemDraft-supported drawing defaults; unsupported binary .cds settings were not decoded."
      }
    ]
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
