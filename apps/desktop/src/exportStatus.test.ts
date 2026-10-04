import { describe, expect, it } from "vitest";
import { formatExportStatus } from "./MainWindow";

const smilesRefusal = "Cannot write SMILES: bond b1 has an unknown bond order.";

describe("formatExportStatus", () => {
  it("reports SDfile records as exported without SMILES", () => {
    expect(formatExportStatus("MDL SDfile", [{ message: smilesRefusal, severity: "error" }])).toBe(
      `Exported MDL SDfile with 1 warning(s); 1 structure exported without SMILES: ${smilesRefusal}`
    );
  });

  it("reports SMILES-file omissions as structures that could not be written", () => {
    expect(formatExportStatus("SMILES", [{ message: smilesRefusal, severity: "error" }])).toBe(
      `Exported SMILES with 1 warning(s); 1 structure could not be written: ${smilesRefusal}`
    );
  });
});
