import { describe, expect, it } from "vitest";
import { disconnectedEditorCapabilities, type EditorAdapter } from "./index";

describe("disconnectedEditorCapabilities", () => {
  it("reports an honest disconnected editor state", () => {
    expect(disconnectedEditorCapabilities).toMatchObject({
      connected: false,
      implementationName: "EditorAdapter not connected",
      canEditMolecules: false,
      canEditReactions: false,
      canEditPageLayoutObjects: false
    });
    expect(disconnectedEditorCapabilities.supportedFormats).toEqual([]);
    expect(disconnectedEditorCapabilities.warnings).toEqual([
      "No drawing engine has been connected through EditorAdapter."
    ]);
  });

  it("keeps the adapter contract focused on object editing, not page ownership", () => {
    const adapterKeys = [
      "focus",
      "clear",
      "loadObject",
      "saveObject",
      "getSelection",
      "exportSvg",
      "getCapabilities",
      "onChange"
    ] satisfies Array<keyof EditorAdapter>;

    expect(adapterKeys).not.toContain("saveDocument" as keyof EditorAdapter);
  });
});
