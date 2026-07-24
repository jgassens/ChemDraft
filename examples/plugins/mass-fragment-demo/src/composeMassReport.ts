import type { PluginPanelReport, PluginSelectedMolecule } from "@chemdraft/plugin-api";

import type { MassReport } from "./massAnalysis";

/**
 * Render a {@link MassReport} as a declarative panel report — the same section kinds the NMR plugin
 * uses (keyValue + table + text). The plugin ships data only; the desktop renders it. Carries the
 * `source` ref so the desktop's staleness banner (D-09) works here exactly as it does for NMR.
 */
export function composeMassReport(source: PluginSelectedMolecule, report: MassReport): PluginPanelReport {
  return {
    title: "Mass Analysis",
    source: { objectId: source.objectId, sourceFingerprint: source.sourceFingerprint },
    sections: [
      {
        kind: "keyValue",
        title: "Molecular formula",
        rows: [
          { label: "Formula", value: report.formula },
          { label: "Net charge", value: formatCharge(report.netCharge) },
          { label: "Monoisotopic mass", value: `${report.monoisotopicMass.toFixed(4)} Da` },
          { label: "Average mass", value: `${report.averageMass.toFixed(2)} Da` }
        ]
      },
      {
        kind: "table",
        title: report.netCharge === 0 ? "Common ions (monoisotopic m/z)" : "Native ion (monoisotopic m/z)",
        columns: ["Species", "m/z", "Charge"],
        rows: report.ions.map((ion) => [ion.species, ion.mz.toFixed(4), ion.charge > 0 ? `+${ion.charge}` : String(ion.charge)])
      },
      {
        kind: "table",
        title: "Isotope pattern (first-order approx.)",
        columns: ["Peak", "Rel. intensity"],
        rows: report.isotopePattern.map((peak) => [peak.label, `${peak.relativeIntensity.toFixed(1)} %`])
      },
      {
        kind: "text",
        body: report.netCharge === 0
          ? "Monoisotopic m/z for common ESI adducts. Isotope intensities are normalized to the " +
            "monoisotopic peak and are a first-order approximation (¹³C/¹⁵N for M+1; " +
            "³⁷Cl/⁸¹Br/³⁴S and ¹³C₂ for M+2), not a full isotopic convolution."
          : `The selected structure has net charge ${formatCharge(report.netCharge)}. The table reports its ` +
            "native ion; neutral-precursor adducts are omitted because applying them to an already charged " +
            "structure would be chemically misleading. Isotope intensities are a first-order approximation " +
            "normalized to the monoisotopic peak."
      }
    ]
  };
}

function formatCharge(charge: number): string {
  return charge > 0 ? `+${charge}` : String(charge);
}

/** Error report mirroring the NMR plugin's, so failures surface uniformly in the same panel. */
export function composeMassErrorReport(source: PluginSelectedMolecule, message: string): PluginPanelReport {
  return {
    title: "Mass Analysis",
    source: { objectId: source.objectId, sourceFingerprint: source.sourceFingerprint },
    sections: [{ kind: "text", title: "Could not analyze the selection", body: message }]
  };
}
