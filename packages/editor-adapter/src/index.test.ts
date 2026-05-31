import { describe, expect, it } from "vitest";
import { disconnectedEditorCapabilities, pageLevelEditorGaps, type EditorAdapter } from "./index";

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
    expect(disconnectedEditorCapabilities.gaps).toEqual(pageLevelEditorGaps);
    expect(disconnectedEditorCapabilities.warnings).toEqual([
      "No drawing engine has been connected through EditorAdapter."
    ]);
  });

  it("documents page-level gaps that concrete structure editors must report", () => {
    expect(pageLevelEditorGaps.map((gap) => gap.code)).toEqual([
      "editor.gap.mechanism_annotations",
      "editor.gap.page_layout",
      "editor.gap.superatoms_rgroups"
    ]);
    expect(pageLevelEditorGaps.some((gap) => gap.affectedObjectTypes.includes("mechanism-arrow"))).toBe(true);
    expect(pageLevelEditorGaps.some((gap) => gap.affectedObjectTypes.includes("text"))).toBe(true);
    expect(pageLevelEditorGaps.some((gap) => gap.affectedObjectTypes.includes("molecule"))).toBe(true);
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
