import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ChemDraftDocumentSchema as Released111DocumentSchema } from "./__fixtures__/v1.1.1/schemas";
import { readSerializedDocument, serializeDocument } from "./document";
import { NativeDocumentFormatVersion, NativeDocumentReaderVersion } from "./documentFeatures";
import { compareNativeVersions } from "./nativeCompatibilityState";

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/compat/${name}.chemdraft`, import.meta.url), "utf8");
const needsNotice = (result: ReturnType<typeof readSerializedDocument>) =>
  compareNativeVersions(result.minAppVersion, NativeDocumentReaderVersion) > 0 ||
  (result.formatVersion !== undefined && compareNativeVersions(result.formatVersion, NativeDocumentFormatVersion) > 0);

describe("hands-on native compatibility fixtures", () => {
  it("opens the plain document with the released schema and no notice", () => {
    const contents = fixture("plain-1.2");
    expect(Released111DocumentSchema.safeParse(JSON.parse(contents)).success).toBe(true);
    const result = readSerializedDocument(contents);
    expect(result).toMatchObject({ minAppVersion: "1.1.1", formatVersion: undefined, warnings: [] });
    expect(needsNotice(result)).toBe(false);
  });

  it("opens and preserves newer declared visual fields with a notice", () => {
    const contents = fixture("newer-1.3");
    const result = readSerializedDocument(contents);
    expect(result).toMatchObject({ minAppVersion: "1.3.0", formatVersion: "1.3.0" });
    expect(needsNotice(result)).toBe(true);
    expect(result.warnings.map(w => w.code)).toEqual(Array(3).fill("NATIVE_UNKNOWN_FIELD_PRESERVED"));
    expect(JSON.parse(serializeDocument(result.document))).toEqual(JSON.parse(contents));
  });

  it("notices a newer format even without a minimum or warnings", () => {
    const result = readSerializedDocument(fixture("newer-format-only"));
    expect(result).toMatchObject({ formatVersion: "1.3.0", minAppVersion: "1.1.1", warnings: [] });
    expect(needsNotice(result)).toBe(true);
  });

  it("opens an unversioned unknown arrow with a visual warning", () => {
    const result = readSerializedDocument(fixture("unknown-visual-enum"));
    expect(needsNotice(result)).toBe(false);
    expect(result.warnings).toEqual([expect.objectContaining({ code: "NATIVE_VISUAL_ENUM_FALLBACK", path: ["pages", 0, "objects", 1, "arrowKind"], originalValue: "future-arrow" })]);
    expect(result.document.pages[0]!.objects[1]).toMatchObject({ arrowKind: "unknown" });
  });

  it("opens an unversioned unknown bond order with a chemistry warning", () => {
    const result = readSerializedDocument(fixture("unknown-bond-order"));
    expect(needsNotice(result)).toBe(false);
    expect(result.warnings).toEqual([expect.objectContaining({ code: "NATIVE_CHEMISTRY_ENUM_FALLBACK", path: ["pages", 0, "objects", 0, "bonds", 0, "order"], originalValue: "future-order" })]);
    expect(result.document.pages[0]!.objects[0]).toMatchObject({ bonds: [expect.objectContaining({ order: "unknown" }), ...Array(5).fill(expect.anything())] });
  });

  it("refuses an undeclared unknown atom field", () => {
    try {
      readSerializedDocument(fixture("unknown-chem-field"));
      expect.fail("Expected an unsupported chemistry error");
    } catch (error) {
      expect(error).toMatchObject({ code: "NATIVE_UNSUPPORTED_CHEMISTRY", path: ["pages", 0, "objects", 0, "atoms", 0, "futureChemistry"], originalValue: "unknown" });
    }
  });
});
