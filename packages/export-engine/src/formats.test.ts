import { describe, expect, it } from "vitest";
import {
  exportFormatDescriptors,
  getExportFormatDescriptor,
  isExportFormatImplemented,
  listExportFormats,
  listImplementedExportFormats,
  type ExportFormatDescriptor,
  type ExportFormatId
} from "./index";

const wishlistFormatIds = [
  "svg",
  "pdf",
  "png",
  "jpeg",
  "bmp",
  "gif",
  "tiff",
  "eps",
  "mol",
  "mol-v2000",
  "sdf",
  "sdf-v2000",
  "rxn",
  "rxn-v2000",
  "cml",
  "smiles",
  "connection-table",
  "rdf",
  "rdf-v2000",
  "cdxml",
  "cdx",
  "chemdraw-stationery",
  "chemdraw-3x",
  "tgf",
  "isis-skc",
  "msi-chemnote",
  "smd-42",
  "3mf-display",
  "3mf-printing"
] as const satisfies readonly ExportFormatId[];

describe("export format registry", () => {
  it("tracks every wishlist export format exactly once", () => {
    const ids = exportFormatDescriptors.map((descriptor) => descriptor.id);

    expect(ids).toEqual([...wishlistFormatIds]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps descriptors complete enough for menus and export routing", () => {
    for (const descriptor of exportFormatDescriptors) {
      expect(descriptor.id).toBeTruthy();
      expect(descriptor.label).toBeTruthy();
      expect(descriptor.menuLabel).toBeTruthy();
      expect(descriptor.group).toMatch(/^(graphics|chemistry|compatibility|legacy|model3d)$/);
      expect(descriptor.extensions.length).toBeGreaterThan(0);
      expect(descriptor.extensions.every((extension) => extension.length > 0)).toBe(true);
      expect(descriptor.mimeType).toBeTruthy();
      expect(descriptor.status).toMatch(/^(implemented|planned|deferred|unsupported)$/);
      expect(descriptor.targetScope).toMatch(/^(page|selection|molecule|reaction|multiRecord|model3d)$/);
      expect(descriptor.textOrBinary).toMatch(/^(text|binary)$/);
      expect(typeof descriptor.chemicallyMeaningful).toBe("boolean");
    }
  });

  it("returns stable read-only descriptor lists", () => {
    expect(listExportFormats()).toBe(exportFormatDescriptors);
    expect(listExportFormats().map((descriptor) => descriptor.id)).toEqual([...wishlistFormatIds]);
  });

  it("looks up descriptors by format id", () => {
    expect(getExportFormatDescriptor("svg")).toMatchObject({
      id: "svg",
      status: "implemented",
      mimeType: "image/svg+xml"
    } satisfies Partial<ExportFormatDescriptor>);
    expect(getExportFormatDescriptor("cdxml")).toMatchObject({
      id: "cdxml",
      group: "compatibility",
      status: "implemented"
    } satisfies Partial<ExportFormatDescriptor>);
  });

  it("marks only formats with real export-engine implementations as implemented", () => {
    expect(listImplementedExportFormats().map((descriptor) => descriptor.id)).toEqual([
      "svg",
      "pdf",
      "png",
      "jpeg",
      "bmp",
      "gif",
      "tiff",
      "cdxml"
    ]);
    expect(isExportFormatImplemented("svg")).toBe(true);
    expect(isExportFormatImplemented("pdf")).toBe(true);
    expect(isExportFormatImplemented("png")).toBe(true);
    expect(isExportFormatImplemented("jpeg")).toBe(true);
    expect(isExportFormatImplemented("bmp")).toBe(true);
    expect(isExportFormatImplemented("gif")).toBe(true);
    expect(isExportFormatImplemented("tiff")).toBe(true);
    expect(isExportFormatImplemented("cdxml")).toBe(true);
    expect(exportFormatDescriptors.filter((descriptor) => descriptor.status !== "implemented").length).toBe(
      wishlistFormatIds.length - 8
    );
  });

  it("keeps legal-risk and semantic-risk formats disabled", () => {
    const disabledFormatIds = [
      "cdx",
      "chemdraw-stationery",
      "chemdraw-3x",
      "tgf",
      "isis-skc",
      "msi-chemnote",
      "smd-42",
      "eps",
      "3mf-display",
      "3mf-printing"
    ] as const satisfies readonly ExportFormatId[];

    for (const id of disabledFormatIds) {
      expect(getExportFormatDescriptor(id).status).toBe("deferred");
      expect(isExportFormatImplemented(id)).toBe(false);
      expect(getExportFormatDescriptor(id).warningSummary).toBeTruthy();
    }
  });
});
