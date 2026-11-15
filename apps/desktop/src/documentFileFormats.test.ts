// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { exportDocumentToCdx, importCdx } from "@chemdraft/cdx-compat";
import { createDialogExportResult } from "./MainWindow";
import { applyNativeChainTool, createNativeSavePayload, createPhase4Document } from "./documentWorkflow";
import { createDocumentFileSave } from "./documentFileFormats";
import { desktopExportFormatDescriptors, getDesktopExportFormatDescriptor } from "./desktopExportFormats";
import { updateExportDialogFormat } from "./dialogs/ExportForm";
import { exportFixture } from "./dialogs/exportTestFixtures";

describe("desktop CDX save and export", () => {
  const document = applyNativeChainTool(createPhase4Document("Binary saving"), { x: 100, y: 100 }, { x: 180, y: 100 });

  it.each(["/drawings/new.cdx", "C:\\drawings\\existing.CDX"])("saves %s with the exact native payload and codec warnings", path => {
    const result = createDocumentFileSave(document, path);
    expect(result.kind).toBe("binary");
    if (result.kind !== "binary") throw new Error("Expected CDX bytes");
    expect(result.bytes).toEqual(exportDocumentToCdx(document, { embedNativePayload: true }).bytes);
    expect(result.warnings).toEqual(exportDocumentToCdx(document, { embedNativePayload: true }).warnings);
    expect(importCdx(result.bytes).source).toBe("native-payload");
    expect(result.filename).toBe(path.split(/[\\/]/).pop());
  });

  it("keeps default, .chemdraft and .cdxml saves on the existing text path", () => {
    for (const path of [undefined, "drawing.chemdraft", "drawing.cdxml"]) {
      const result = createDocumentFileSave(document, path);
      expect(result.kind === "text" && result.contents).toBe(createNativeSavePayload(document).contents);
    }
  });

  it("offers CDX in Export and writes visible binary bytes without the native payload", async () => {
    const state = updateExportDialogFormat({ ...exportFixture(), busy: false }, "cdx");
    expect(state.filename.endsWith(".cdx")).toBe(true);
    expect(desktopExportFormatDescriptors.find(format => format.id === "cdx")).toBe(getDesktopExportFormatDescriptor("cdx"));
    expect(getDesktopExportFormatDescriptor("cdx").status).toBe("implemented");
    const result = await createDialogExportResult(document, state);
    expect(result.kind).toBe("binary");
    if (result.kind !== "binary") throw new Error("Expected CDX bytes");
    const expected = exportDocumentToCdx(document, { embedNativePayload: false });
    expect(result.bytes).toEqual(expected.bytes);
    expect(result.warnings).toEqual(expected.warnings);
    const reopened = importCdx(result.bytes);
    expect(reopened.source).toBe("external-cdxml");
    expect(reopened.document?.pages[0].objects.filter(object => object.type === "molecule")).toHaveLength(1);
  });
});
