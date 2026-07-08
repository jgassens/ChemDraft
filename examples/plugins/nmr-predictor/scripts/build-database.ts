/**
 * Compile a NMReDATA/SDF export into the bundled predictor database.
 *
 *   npx tsx examples/plugins/nmr-predictor/scripts/build-database.ts <input.sd> <output.json>
 *
 * Input: an atom-assigned NMReDATA export (e.g. NMRShiftDB2's nmrshiftdb2rawdata.nmredata.sd).
 * Output: aggregated HOSE-code → shift statistics (JSON). Only statistics are written — never raw
 * structures — so the artifact is small and is a separate, attributed data asset (see ADR-0014).
 */
import { readFileSync, writeFileSync } from "node:fs";

import { buildNmrDatabase } from "../src/providers/ocl/buildDatabase";

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error("usage: build-database <input.sd> <output.json>");
  process.exit(1);
}

const database = buildNmrDatabase(readFileSync(input, "utf8"), {
  provenance: {
    name: "NMRShiftDB2 (NMReDATA export)",
    version: "nmrshiftdb2rawdata.nmredata.sd",
    source: "https://sourceforge.net/projects/nmrshiftdb2/files/data/",
    license: "nmrshiftdb2 Database License (ODbL-derived)",
    licenseUrl: "https://nmrshiftdb.nmr.uni-koeln.de/nmrshiftdbhtml/nmrshiftdb2datalicense.txt",
    attribution:
      "Shift data © nmrshiftdb2 contributors, used under the nmrshiftdb2 Database License. Compiled HOSE-code statistics derived by ChemDraft.",
    note: "Aggregated experimental ¹H/¹³C environment-code shift statistics from atom-assigned NMReDATA."
  }
});

writeFileSync(output, `${JSON.stringify(database)}\n`);
console.log(
  `entries=${database.provenance.entryCount} structures=${database.provenance.structureCount} nuclei=${database.provenance.nuclei.join(",")}`
);
