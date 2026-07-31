import type {
  PluginIsotopeEnvelopeResult,
  PluginPanelReport,
  PluginPanelSection,
  PluginSelectedMolecule
} from "@chemdraft/plugin-api";

import type { MassReport } from "./massAnalysis";

/** Most envelope peaks the panel lists. The engine keeps every peak; a capped table says it is capped. */
const MAX_RENDERED_PEAKS = 20;

/**
 * The isotope section, or an honest account of why there is not one.
 *
 * `undefined` means `chemistry.compute` was not granted, so nothing was ever asked. `available: false`
 * means it was asked and could not be answered — an engine-less host, or a structure the engine
 * declines (a charge it cannot account for, an isotope label it cannot express). Those are different
 * facts and the panel states which, rather than showing an empty table or — as this plugin used to — a
 * first-order estimate of its own.
 */
function isotopeSections(envelope: PluginIsotopeEnvelopeResult | undefined): PluginPanelSection[] {
  if (!envelope) {
    return [
      {
        kind: "text",
        title: "Isotope pattern",
        body:
          "Not computed: the chemistry.compute permission was not granted, so no isotope engine was " +
          "asked. This plugin no longer estimates isotope patterns itself."
      }
    ];
  }

  if (!envelope.available) {
    return [{ kind: "text", title: "Isotope pattern", body: `Not computed: ${envelope.reason}` }];
  }

  const shown = envelope.peaks.length > MAX_RENDERED_PEAKS
    ? [...envelope.peaks].sort((a, b) => b.relativeIntensity - a.relativeIntensity).slice(0, MAX_RENDERED_PEAKS).sort((a, b) => a.mass - b.mass)
    : envelope.peaks;

  const covered = envelope.truncation.coveredProbability;
  const detail = [
    `${envelope.peaks.length} peaks`,
    ...(covered === undefined ? [] : [`${(covered * 100).toFixed(4)}% of the distribution`]),
    ...(shown.length < envelope.peaks.length ? [`showing the ${shown.length} most intense`] : [])
  ].join(", ");

  return [
    {
      kind: "table",
      title: `Isotope pattern (${detail})`,
      columns: ["Mass (Da)", "Rel. intensity"],
      rows: shown.map((peak) => [peak.mass.toFixed(5), `${peak.relativeIntensity.toFixed(2)} %`])
    },
    {
      kind: "text",
      body:
        `Computed by ${envelope.engine.id} ${envelope.engine.version} via the host, not by this plugin. ` +
        `Truncation: ${envelope.truncation.policy} at ${envelope.truncation.threshold}. ` +
        `Conventions — ${envelope.conventions.join(" · ")}`
    }
  ];
}

/**
 * Render a {@link MassReport} as a declarative panel report — the same section kinds the NMR plugin
 * uses (keyValue + table + text). The plugin ships data only; the desktop renders it. Carries the
 * `source` ref so the desktop's staleness banner (D-09) works here exactly as it does for NMR.
 */
export function composeMassReport(
  source: PluginSelectedMolecule,
  report: MassReport,
  envelope?: PluginIsotopeEnvelopeResult
): PluginPanelReport {
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
      ...isotopeSections(envelope),
      {
        kind: "text",
        body: report.netCharge === 0
          ? "Monoisotopic m/z for common ESI adducts."
          : `The selected structure has net charge ${formatCharge(report.netCharge)}. The table reports its ` +
            "native ion; neutral-precursor adducts are omitted because applying them to an already charged " +
            "structure would be chemically misleading."
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
