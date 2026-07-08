/**
 * Synthetic fixture shift table, keyed by the carbon-centered environment code that
 * `fixtureEnvironment.ts` produces (¹H shifts are keyed by their host carbon's code). The keys were
 * captured from the actual generator output for the fixture molecules, so lookups are exact.
 *
 * ⚠️ These ppm values are HAND-AUTHORED SYNTHETIC FIXTURES chosen to be roughly plausible and to
 * exercise the architecture (complete / partial / no-match, equivalence grouping, uncertainty). They
 * are NOT experimental reference data and must never be presented as measured shifts. The prediction
 * method is labeled "fixture-fragment" downstream so this is unambiguous.
 *
 * Coverage (fully supported): benzene, toluene, acetone, ethanol, ethyl acetate, acetonitrile,
 * cyclohexane, anisole, p-xylene. Ethylbenzene is intentionally only partially covered — its meta/para
 * ring carbons match shared aromatic codes while its ethyl group and ipso/ortho carbons do not.
 */

export interface FixtureShift {
  shiftPpm: number;
  standardDeviationPpm: number;
  sampleCount: number;
}

export interface FixtureEnvironmentEntry {
  /** ¹³C shift for a carbon with this environment. */
  carbon13?: FixtureShift;
  /** ¹H shift for the hydrogens on a carbon with this environment. */
  proton1H?: FixtureShift;
}

export const FIXTURE_DATA_VERSION = "fixture-2026-07-synthetic";

export const FIXTURE_DATABASE: ReadonlyMap<string, FixtureEnvironmentEntry> = new Map<
  string,
  FixtureEnvironmentEntry
>([
  // --- aromatic CH / substituted-benzene ring carbons (shared across benzene, toluene, anisole, …) ---
  [
    "Caq0h1(~Cah1,~Cah1)(~Cah1,~Cah1)",
    { carbon13: { shiftPpm: 128.5, standardDeviationPpm: 0.4, sampleCount: 8 }, proton1H: { shiftPpm: 7.26, standardDeviationPpm: 0.05, sampleCount: 8 } }
  ],
  [
    "Caq0h1(~Cah1,~Cah1)(~Cah0,~Cah1)",
    { carbon13: { shiftPpm: 128.3, standardDeviationPpm: 0.4, sampleCount: 4 }, proton1H: { shiftPpm: 7.22, standardDeviationPpm: 0.05, sampleCount: 4 } }
  ],
  // --- toluene ---
  [
    "Cq0h3(1Cah0)(~Cah1,~Cah1)",
    { carbon13: { shiftPpm: 21.3, standardDeviationPpm: 0.4, sampleCount: 4 }, proton1H: { shiftPpm: 2.32, standardDeviationPpm: 0.04, sampleCount: 4 } }
  ],
  ["Caq0h0(1Ch3,~Cah1,~Cah1)(~Cah1,~Cah1)", { carbon13: { shiftPpm: 137.8, standardDeviationPpm: 0.6, sampleCount: 3 } }],
  [
    "Caq0h1(~Cah0,~Cah1)(1Ch3,~Cah1,~Cah1)",
    { carbon13: { shiftPpm: 129.1, standardDeviationPpm: 0.4, sampleCount: 3 }, proton1H: { shiftPpm: 7.15, standardDeviationPpm: 0.05, sampleCount: 3 } }
  ],
  // --- acetone ---
  [
    "Cq0h3(1Ch0)(1Ch3,2Oh0)",
    { carbon13: { shiftPpm: 30.8, standardDeviationPpm: 0.3, sampleCount: 2 }, proton1H: { shiftPpm: 2.1, standardDeviationPpm: 0.03, sampleCount: 2 } }
  ],
  ["Cq0h0(1Ch3,1Ch3,2Oh0)()", { carbon13: { shiftPpm: 206.6, standardDeviationPpm: 0.8, sampleCount: 1 } }],
  // --- ethanol ---
  [
    "Cq0h3(1Ch2)(1Oh1)",
    { carbon13: { shiftPpm: 18.3, standardDeviationPpm: 0.3, sampleCount: 1 }, proton1H: { shiftPpm: 1.19, standardDeviationPpm: 0.03, sampleCount: 1 } }
  ],
  [
    "Cq0h2(1Ch3,1Oh1)()",
    { carbon13: { shiftPpm: 58.0, standardDeviationPpm: 0.4, sampleCount: 1 }, proton1H: { shiftPpm: 3.68, standardDeviationPpm: 0.04, sampleCount: 1 } }
  ],
  // --- ethyl acetate ---
  [
    "Cq0h3(1Ch2)(1Oh0)",
    { carbon13: { shiftPpm: 14.2, standardDeviationPpm: 0.3, sampleCount: 1 }, proton1H: { shiftPpm: 1.26, standardDeviationPpm: 0.03, sampleCount: 1 } }
  ],
  [
    "Cq0h2(1Ch3,1Oh0)(1Ch0)",
    { carbon13: { shiftPpm: 60.4, standardDeviationPpm: 0.4, sampleCount: 1 }, proton1H: { shiftPpm: 4.12, standardDeviationPpm: 0.04, sampleCount: 1 } }
  ],
  ["Cq0h0(1Ch3,1Oh0,2Oh0)(1Ch2)", { carbon13: { shiftPpm: 171.1, standardDeviationPpm: 0.7, sampleCount: 1 } }],
  [
    "Cq0h3(1Ch0)(1Oh0,2Oh0)",
    { carbon13: { shiftPpm: 21.0, standardDeviationPpm: 0.3, sampleCount: 1 }, proton1H: { shiftPpm: 2.04, standardDeviationPpm: 0.03, sampleCount: 1 } }
  ],
  // --- acetonitrile ---
  [
    "Cq0h3(1Ch0)(3Nh0)",
    { carbon13: { shiftPpm: 1.9, standardDeviationPpm: 0.2, sampleCount: 1 }, proton1H: { shiftPpm: 1.98, standardDeviationPpm: 0.03, sampleCount: 1 } }
  ],
  ["Cq0h0(1Ch3,3Nh0)()", { carbon13: { shiftPpm: 118.7, standardDeviationPpm: 0.5, sampleCount: 1 } }],
  // --- cyclohexane ---
  [
    "Cq0h2(1Ch2,1Ch2)(1Ch2,1Ch2)",
    { carbon13: { shiftPpm: 27.0, standardDeviationPpm: 0.3, sampleCount: 1 }, proton1H: { shiftPpm: 1.43, standardDeviationPpm: 0.03, sampleCount: 1 } }
  ],
  // --- anisole ---
  [
    "Cq0h3(1Oh0)(1Cah0)",
    { carbon13: { shiftPpm: 55.1, standardDeviationPpm: 0.3, sampleCount: 1 }, proton1H: { shiftPpm: 3.78, standardDeviationPpm: 0.03, sampleCount: 1 } }
  ],
  ["Caq0h0(1Oh0,~Cah1,~Cah1)(1Ch3,~Cah1,~Cah1)", { carbon13: { shiftPpm: 159.6, standardDeviationPpm: 0.6, sampleCount: 1 } }],
  [
    "Caq0h1(~Cah0,~Cah1)(1Oh0,~Cah1,~Cah1)",
    { carbon13: { shiftPpm: 114.1, standardDeviationPpm: 0.4, sampleCount: 1 }, proton1H: { shiftPpm: 6.89, standardDeviationPpm: 0.04, sampleCount: 1 } }
  ],
  // --- p-xylene aromatic CH ---
  [
    "Caq0h1(~Cah0,~Cah1)(1Ch3,~Cah0,~Cah1)",
    { carbon13: { shiftPpm: 129.1, standardDeviationPpm: 0.4, sampleCount: 4 }, proton1H: { shiftPpm: 7.05, standardDeviationPpm: 0.04, sampleCount: 4 } }
  ]
]);
