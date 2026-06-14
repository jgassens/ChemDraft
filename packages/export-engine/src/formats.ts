export type ExportFormatId =
  | "svg"
  | "pdf"
  | "png"
  | "jpeg"
  | "bmp"
  | "gif"
  | "tiff"
  | "eps"
  | "mol"
  | "mol-v2000"
  | "sdf"
  | "sdf-v2000"
  | "rxn"
  | "rxn-v2000"
  | "cml"
  | "smiles"
  | "connection-table"
  | "rdf"
  | "rdf-v2000"
  | "cdxml"
  | "cdx"
  | "chemdraw-stationery"
  | "chemdraw-3x"
  | "tgf"
  | "isis-skc"
  | "msi-chemnote"
  | "smd-42"
  | "3mf-display"
  | "3mf-printing";

export type ExportFormatGroup = "graphics" | "chemistry" | "compatibility" | "legacy" | "model3d";
export type ExportImplementationStatus = "implemented" | "planned" | "deferred" | "unsupported";
export type ExportTargetScope = "page" | "selection" | "molecule" | "reaction" | "multiRecord" | "model3d";
export type ExportPayloadKind = "text" | "binary";

export interface ExportFormatDescriptor {
  id: ExportFormatId;
  label: string;
  menuLabel: string;
  group: ExportFormatGroup;
  extensions: readonly string[];
  mimeType: string;
  status: ExportImplementationStatus;
  targetScope: ExportTargetScope;
  textOrBinary: ExportPayloadKind;
  chemicallyMeaningful: boolean;
  warningSummary?: string;
  dependency?: string;
}

export const exportFormatDescriptors = [
  {
    id: "svg",
    label: "Scalable Vector Graphics (SVG)",
    menuLabel: "SVG",
    group: "graphics",
    extensions: ["svg"],
    mimeType: "image/svg+xml",
    status: "implemented",
    targetScope: "page",
    textOrBinary: "text",
    chemicallyMeaningful: false
  },
  {
    id: "pdf",
    label: "Portable Document Format (PDF)",
    menuLabel: "PDF",
    group: "graphics",
    extensions: ["pdf"],
    mimeType: "application/pdf",
    status: "implemented",
    targetScope: "page",
    textOrBinary: "binary",
    chemicallyMeaningful: false,
    warningSummary: "Vector PDF export uses the SVG export path and propagates SVG compatibility warnings.",
    dependency: "svg2pdf.js + jspdf"
  },
  {
    id: "png",
    label: "Portable Network Graphics (PNG)",
    menuLabel: "PNG",
    group: "graphics",
    extensions: ["png"],
    mimeType: "image/png",
    status: "implemented",
    targetScope: "page",
    textOrBinary: "binary",
    chemicallyMeaningful: false,
    warningSummary: "Desktop raster export renders the SVG page through the native resvg pipeline.",
    dependency: "resvg + image"
  },
  {
    id: "jpeg",
    label: "JPEG",
    menuLabel: "JPEG",
    group: "graphics",
    extensions: ["jpg", "jpeg"],
    mimeType: "image/jpeg",
    status: "implemented",
    targetScope: "page",
    textOrBinary: "binary",
    chemicallyMeaningful: false,
    warningSummary: "JPEG export flattens transparency onto a white background.",
    dependency: "resvg + image"
  },
  {
    id: "bmp",
    label: "Bitmap Image (BMP)",
    menuLabel: "BMP",
    group: "graphics",
    extensions: ["bmp"],
    mimeType: "image/bmp",
    status: "implemented",
    targetScope: "page",
    textOrBinary: "binary",
    chemicallyMeaningful: false,
    warningSummary: "BMP export flattens transparency onto a white background.",
    dependency: "resvg + image"
  },
  {
    id: "gif",
    label: "Graphics Interchange Format (GIF)",
    menuLabel: "GIF",
    group: "graphics",
    extensions: ["gif"],
    mimeType: "image/gif",
    status: "implemented",
    targetScope: "page",
    textOrBinary: "binary",
    chemicallyMeaningful: false,
    warningSummary: "GIF export flattens transparency onto a white background before palette encoding.",
    dependency: "resvg + image"
  },
  {
    id: "tiff",
    label: "Tagged Image File Format (TIFF)",
    menuLabel: "TIFF",
    group: "graphics",
    extensions: ["tif", "tiff"],
    mimeType: "image/tiff",
    status: "implemented",
    targetScope: "page",
    textOrBinary: "binary",
    chemicallyMeaningful: false,
    warningSummary: "TIFF export flattens transparency onto a white background.",
    dependency: "resvg + image"
  },
  {
    id: "eps",
    label: "Encapsulated PostScript (EPS)",
    menuLabel: "EPS",
    group: "graphics",
    extensions: ["eps"],
    mimeType: "application/postscript",
    status: "deferred",
    targetScope: "page",
    textOrBinary: "text",
    chemicallyMeaningful: false,
    warningSummary: "EPS should use a focused native writer, not GPL/AGPL converters."
  },
  {
    id: "mol",
    label: "MDL Molfile",
    menuLabel: "MDL Molfile",
    group: "chemistry",
    extensions: ["mol"],
    mimeType: "chemical/x-mdl-molfile",
    status: "planned",
    targetScope: "molecule",
    textOrBinary: "text",
    chemicallyMeaningful: true,
    warningSummary: "Initial MOL export should alias the tested V2000 writer."
  },
  {
    id: "mol-v2000",
    label: "MDL Molfile V2000",
    menuLabel: "MDL Molfile V2000",
    group: "chemistry",
    extensions: ["mol"],
    mimeType: "chemical/x-mdl-molfile",
    status: "planned",
    targetScope: "molecule",
    textOrBinary: "text",
    chemicallyMeaningful: true
  },
  {
    id: "sdf",
    label: "MDL SDfile",
    menuLabel: "MDL SDfile",
    group: "chemistry",
    extensions: ["sdf"],
    mimeType: "chemical/x-mdl-sdfile",
    status: "planned",
    targetScope: "multiRecord",
    textOrBinary: "text",
    chemicallyMeaningful: true,
    warningSummary: "Initial SDF export should alias the tested V2000 writer."
  },
  {
    id: "sdf-v2000",
    label: "MDL SDfile V2000",
    menuLabel: "MDL SDfile V2000",
    group: "chemistry",
    extensions: ["sdf"],
    mimeType: "chemical/x-mdl-sdfile",
    status: "planned",
    targetScope: "multiRecord",
    textOrBinary: "text",
    chemicallyMeaningful: true
  },
  {
    id: "rxn",
    label: "Reaction Molfile (RXN)",
    menuLabel: "RXN",
    group: "chemistry",
    extensions: ["rxn"],
    mimeType: "chemical/x-mdl-rxnfile",
    status: "planned",
    targetScope: "reaction",
    textOrBinary: "text",
    chemicallyMeaningful: true,
    warningSummary: "Initial RXN export should alias the tested V2000 writer."
  },
  {
    id: "rxn-v2000",
    label: "Reaction Molfile V2000 (RXN)",
    menuLabel: "RXN V2000",
    group: "chemistry",
    extensions: ["rxn"],
    mimeType: "chemical/x-mdl-rxnfile",
    status: "planned",
    targetScope: "reaction",
    textOrBinary: "text",
    chemicallyMeaningful: true
  },
  {
    id: "cml",
    label: "Chemical Markup Language (CML)",
    menuLabel: "CML",
    group: "chemistry",
    extensions: ["cml"],
    mimeType: "chemical/x-cml",
    status: "planned",
    targetScope: "molecule",
    textOrBinary: "text",
    chemicallyMeaningful: true
  },
  {
    id: "smiles",
    label: "SMILES",
    menuLabel: "SMILES",
    group: "chemistry",
    extensions: ["smi", "smiles"],
    mimeType: "chemical/x-daylight-smiles",
    status: "planned",
    targetScope: "molecule",
    textOrBinary: "text",
    chemicallyMeaningful: true
  },
  {
    id: "connection-table",
    label: "Connection Table",
    menuLabel: "Connection Table",
    group: "chemistry",
    extensions: ["ctab"],
    mimeType: "chemical/x-mdl-molfile",
    status: "deferred",
    targetScope: "molecule",
    textOrBinary: "text",
    chemicallyMeaningful: true,
    warningSummary: "Connection table export should be defined through the MOL/CTAB writer before it is enabled."
  },
  {
    id: "rdf",
    label: "MDL RDfile",
    menuLabel: "MDL RDfile",
    group: "chemistry",
    extensions: ["rdf"],
    mimeType: "chemical/x-mdl-rdfile",
    status: "deferred",
    targetScope: "multiRecord",
    textOrBinary: "text",
    chemicallyMeaningful: true,
    warningSummary: "RDfile should wait until MOL, SDF, and RXN writers are stable."
  },
  {
    id: "rdf-v2000",
    label: "MDL RDfile V2000",
    menuLabel: "MDL RDfile V2000",
    group: "chemistry",
    extensions: ["rdf"],
    mimeType: "chemical/x-mdl-rdfile",
    status: "deferred",
    targetScope: "multiRecord",
    textOrBinary: "text",
    chemicallyMeaningful: true,
    warningSummary: "RDfile V2000 should wait until MOL, SDF, and RXN writers are stable."
  },
  {
    id: "cdxml",
    label: "ChemDraw XML (CDXML)",
    menuLabel: "CDXML",
    group: "compatibility",
    extensions: ["cdxml"],
    mimeType: "chemical/x-cdxml",
    status: "implemented",
    targetScope: "page",
    textOrBinary: "text",
    chemicallyMeaningful: true,
    warningSummary: "CDXML export delegates through cdx-compat and may include compatibility warnings for unsupported visible objects."
  },
  {
    id: "cdx",
    label: "ChemDraw Binary (CDX)",
    menuLabel: "CDX",
    group: "compatibility",
    extensions: ["cdx"],
    mimeType: "chemical/x-cdx",
    status: "deferred",
    targetScope: "page",
    textOrBinary: "binary",
    chemicallyMeaningful: true,
    warningSummary: "Best-effort CDX read/paste should precede CDX writing."
  },
  {
    id: "chemdraw-stationery",
    label: "ChemDraw Stationery",
    menuLabel: "ChemDraw Stationery",
    group: "legacy",
    extensions: ["cds"],
    mimeType: "application/octet-stream",
    status: "deferred",
    targetScope: "page",
    textOrBinary: "binary",
    chemicallyMeaningful: false,
    warningSummary: "Stationery export needs clean-room format research before implementation."
  },
  {
    id: "chemdraw-3x",
    label: "ChemDraw 3.x",
    menuLabel: "ChemDraw 3.x",
    group: "legacy",
    extensions: ["chm"],
    mimeType: "application/octet-stream",
    status: "deferred",
    targetScope: "page",
    textOrBinary: "binary",
    chemicallyMeaningful: true,
    warningSummary: "Legacy ChemDraw 3.x export needs clean-room format research before implementation."
  },
  {
    id: "tgf",
    label: "Transportable Graphics (TGF)",
    menuLabel: "TGF",
    group: "legacy",
    extensions: ["tgf"],
    mimeType: "application/octet-stream",
    status: "deferred",
    targetScope: "page",
    textOrBinary: "binary",
    chemicallyMeaningful: false,
    warningSummary: "TGF export needs clean-room format research before implementation."
  },
  {
    id: "isis-skc",
    label: "ISIS/Sketch (SKC)",
    menuLabel: "ISIS/Sketch (SKC)",
    group: "legacy",
    extensions: ["skc"],
    mimeType: "application/octet-stream",
    status: "deferred",
    targetScope: "page",
    textOrBinary: "binary",
    chemicallyMeaningful: true,
    warningSummary: "ISIS/Sketch export needs clean-room format research before implementation."
  },
  {
    id: "msi-chemnote",
    label: "MSI ChemNote",
    menuLabel: "MSI ChemNote",
    group: "legacy",
    extensions: ["mcn"],
    mimeType: "application/octet-stream",
    status: "deferred",
    targetScope: "page",
    textOrBinary: "binary",
    chemicallyMeaningful: true,
    warningSummary: "MSI ChemNote export needs clean-room format research before implementation."
  },
  {
    id: "smd-42",
    label: "SMD 4.2 File",
    menuLabel: "SMD 4.2",
    group: "legacy",
    extensions: ["smd"],
    mimeType: "application/octet-stream",
    status: "deferred",
    targetScope: "page",
    textOrBinary: "binary",
    chemicallyMeaningful: true,
    warningSummary: "SMD 4.2 export needs clean-room format research before implementation."
  },
  {
    id: "3mf-display",
    label: "3D Manufacturing Format for Display (3MF)",
    menuLabel: "3MF Display",
    group: "model3d",
    extensions: ["3mf"],
    mimeType: "model/3mf",
    status: "deferred",
    targetScope: "model3d",
    textOrBinary: "binary",
    chemicallyMeaningful: false,
    warningSummary: "3MF display export needs a real 3D model pipeline before implementation."
  },
  {
    id: "3mf-printing",
    label: "3D Manufacturing Format for Printing (3MF)",
    menuLabel: "3MF Printing",
    group: "model3d",
    extensions: ["3mf"],
    mimeType: "model/3mf",
    status: "deferred",
    targetScope: "model3d",
    textOrBinary: "binary",
    chemicallyMeaningful: false,
    warningSummary: "3MF printing export needs printable mesh semantics before implementation."
  }
] as const satisfies readonly ExportFormatDescriptor[];

const exportFormatDescriptorMap = new Map<ExportFormatId, ExportFormatDescriptor>(
  exportFormatDescriptors.map((descriptor) => [descriptor.id, descriptor])
);

export function listExportFormats(): readonly ExportFormatDescriptor[] {
  return exportFormatDescriptors;
}

export function getExportFormatDescriptor(id: ExportFormatId): ExportFormatDescriptor {
  const descriptor = exportFormatDescriptorMap.get(id);
  if (!descriptor) {
    throw new Error(`Unknown export format "${id}".`);
  }
  return descriptor;
}

export function listImplementedExportFormats(): readonly ExportFormatDescriptor[] {
  return exportFormatDescriptors.filter((descriptor) => descriptor.status === "implemented");
}

export function isExportFormatImplemented(id: ExportFormatId): boolean {
  return getExportFormatDescriptor(id).status === "implemented";
}
