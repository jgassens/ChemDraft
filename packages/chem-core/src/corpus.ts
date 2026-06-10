/**
 * Phase 1C — labeled validation corpus + runner (dev-only, engine-free).
 *
 * The plan (`docs/architecture/3d-spin-flatten.md`) calls the corpus "a decision
 * tool, not a demo set": every fixture carries a hard label — `mustCommit`,
 * `warnButAllow`, or `mustRefuse` — and the runner asserts that the *real* Phase 1B
 * `flattenPerspectiveFrom3D` produces that labeled outcome. This regression-locks
 * the flatten/wedge behavior against a designed adversarial set so future changes
 * cannot silently turn a refusal into a commit (or vice-versa).
 *
 * SCOPE OF THIS SLICE — honesty about what is and isn't here:
 *   • Included: families that can be authored DETERMINISTICALLY without a 3D
 *     conformer engine — achiral, single tetrahedral centers (both handednesses),
 *     conformer/drawn contradiction, edge-on, unspecified-not-invented, vicinal
 *     shared-bond CSP, E/Z edge-on, projection weave (crossing), cyclic-depth.
 *   • Deferred to Phase 2 (need a real engine to GENERATE the 3D): chairs,
 *     cis/trans-cyclohexanes, decalins, norbornane, spiro/bridged/cage,
 *     macrocycles, allenes. Hand-faking "chair" coordinates here and calling them
 *     "validated" would be dishonest fixture inflation — those land once OpenChemLib
 *     can embed them. See `CORPUS_DEFERRED_FAMILIES`.
 *
 * The corpus runs `flattenPerspectiveFrom3D` (geometry only). An independent
 * engine oracle (RDKit, `oracle.ts`) is the *second* line that cross-checks
 * identity in Phase 2+; it is not required to evaluate the labels below.
 */

import { flattenPerspectiveFrom3D, type FlattenWarningCode, type ViewMatrix } from "./perspective";
import type { MoleculeAtom, MoleculeBond, MoleculeObject } from "./schemas";

// ---------------------------------------------------------------------------
// Labels & outcomes
// ---------------------------------------------------------------------------

export type CorpusLabel = "mustCommit" | "warnButAllow" | "mustRefuse";

/**
 * `perspective-cleanup` rides on EVERY committed result by design ("projected
 * geometry may need cleanup") — it is baseline noise, never a `warnButAllow`
 * signal. Only these codes are "meaningful" for label classification.
 */
export const MEANINGFUL_WARNING_CODES: readonly FlattenWarningCode[] = [
  "ez-edge-on",
  "cyclic-depth",
  "ambiguous-crossing-depth",
  "degenerate-drawn-parity" // engine-flip guard could not run for a center
];

export type CorpusOutcome = "committed" | "committedWithWarnings" | "refused";

export interface CorpusCase {
  id: string;
  family: string;
  description: string;
  label: CorpusLabel;
  mol: MoleculeObject;
  coords3d: number[];
  viewMatrix: ViewMatrix;
  /**
   * For `warnButAllow`: the meaningful warning code(s) that MUST be present.
   * For `mustCommit`: must be empty/absent (no meaningful warnings allowed).
   */
  expectWarnings?: FlattenWarningCode[];
  /** For `mustRefuse`: a substring/regex the joined refusalReasons must match. */
  expectRefusalMatch?: RegExp;
}

export interface CorpusCaseResult {
  id: string;
  family: string;
  label: CorpusLabel;
  outcome: CorpusOutcome;
  pass: boolean;
  detail: string;
  meaningfulWarnings: FlattenWarningCode[];
}

export interface CorpusReport {
  total: number;
  passed: number;
  failed: number;
  byLabel: Record<CorpusLabel, { total: number; passed: number }>;
  results: CorpusCaseResult[];
}

/** Families intentionally absent until a conformer engine can embed them (Phase 2). */
export const CORPUS_DEFERRED_FAMILIES: readonly string[] = [
  "chair / cyclohexane",
  "cis-trans-cyclohexane",
  "decalin",
  "norbornane",
  "spiro / bridged / cage",
  "fused-aromatic conformer",
  "medium-ring / macrocycle",
  "allene / axial"
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function classifyOutcome(
  status: "committed" | "refused",
  meaningfulWarnings: FlattenWarningCode[]
): CorpusOutcome {
  if (status === "refused") return "refused";
  return meaningfulWarnings.length > 0 ? "committedWithWarnings" : "committed";
}

function evaluateCase(testCase: CorpusCase): CorpusCaseResult {
  const result = flattenPerspectiveFrom3D(testCase.mol, testCase.coords3d, testCase.viewMatrix, {
    objectId: testCase.mol.id
  });
  const meaningfulWarnings = result.warnings
    .map((w) => w.code)
    .filter((code): code is FlattenWarningCode => MEANINGFUL_WARNING_CODES.includes(code));
  const outcome = classifyOutcome(result.status, meaningfulWarnings);

  let pass = false;
  let detail = "";

  switch (testCase.label) {
    case "mustCommit": {
      pass = outcome === "committed";
      detail = pass
        ? "committed cleanly"
        : `expected clean commit, got ${outcome}` +
          (result.status === "refused" ? ` (${result.refusalReasons.join("; ")})` : "") +
          (meaningfulWarnings.length ? ` warnings=[${meaningfulWarnings.join(",")}]` : "");
      break;
    }
    case "warnButAllow": {
      const expected = testCase.expectWarnings ?? [];
      const hasAll = expected.every((code) => meaningfulWarnings.includes(code));
      pass = outcome === "committedWithWarnings" && hasAll;
      detail = pass
        ? `committed with [${meaningfulWarnings.join(",")}]`
        : `expected commit+warnings ⊇ [${expected.join(",")}], got ${outcome} ` +
          `warnings=[${meaningfulWarnings.join(",")}]` +
          (result.status === "refused" ? ` (${result.refusalReasons.join("; ")})` : "");
      break;
    }
    case "mustRefuse": {
      const reasonText = result.refusalReasons.join("; ");
      const matches = testCase.expectRefusalMatch
        ? testCase.expectRefusalMatch.test(reasonText)
        : true;
      pass = outcome === "refused" && matches;
      detail = pass
        ? `refused: ${reasonText}`
        : outcome !== "refused"
          ? `expected refusal, got ${outcome}`
          : `refused but reason "${reasonText}" did not match ${testCase.expectRefusalMatch}`;
      break;
    }
  }

  return { id: testCase.id, family: testCase.family, label: testCase.label, outcome, pass, detail, meaningfulWarnings };
}

export function runCorpus(cases: readonly CorpusCase[] = CORPUS): CorpusReport {
  const results = cases.map(evaluateCase);
  const byLabel: Record<CorpusLabel, { total: number; passed: number }> = {
    mustCommit: { total: 0, passed: 0 },
    warnButAllow: { total: 0, passed: 0 },
    mustRefuse: { total: 0, passed: 0 }
  };
  for (const r of results) {
    byLabel[r.label].total += 1;
    if (r.pass) byLabel[r.label].passed += 1;
  }
  const passed = results.filter((r) => r.pass).length;
  return { total: results.length, passed, failed: results.length - passed, byLabel, results };
}

/** Human-readable one-line-per-case report (for a dev CLI / CI log). */
export function formatCorpusReport(report: CorpusReport): string {
  const lines = report.results.map(
    (r) => `${r.pass ? "PASS" : "FAIL"}  ${r.label.padEnd(12)}  ${r.id.padEnd(28)}  ${r.detail}`
  );
  lines.push(
    `— ${report.passed}/${report.total} passed ` +
      `(commit ${report.byLabel.mustCommit.passed}/${report.byLabel.mustCommit.total}, ` +
      `warn ${report.byLabel.warnButAllow.passed}/${report.byLabel.warnButAllow.total}, ` +
      `refuse ${report.byLabel.mustRefuse.passed}/${report.byLabel.mustRefuse.total})`
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Fixture construction (self-contained; geometry proven by perspective.test.ts)
// ---------------------------------------------------------------------------

type AtomSpec = { id: string; element: string; x: number; y: number };
type BondSpec = {
  id: string;
  from: string;
  to: string;
  order?: MoleculeBond["order"];
  style?: "wedge" | "hashed";
};

function molecule(id: string, atoms: AtomSpec[], bonds: BondSpec[]): MoleculeObject {
  return {
    id,
    type: "molecule",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    style: {},
    structureFormat: "molfile-v3000",
    structure: "MOCK",
    atoms: atoms.map(({ id: aid, element, x, y }): MoleculeAtom => ({ id: aid, element, x, y, formalCharge: 0 })),
    bonds: bonds.map(
      ({ id: bid, from, to, order = "single", style }): MoleculeBond => ({
        id: bid,
        fromAtomId: from,
        toAtomId: to,
        order,
        ...(style ? { display: { bondStyle: style } } : {})
      })
    ),
    superatoms: [],
    rGroups: []
  };
}

const IDENTITY: ViewMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const Y_SQUASH: ViewMatrix = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Independent 4-substituent parity sign (det form) — to author matching markers. */
function parity4Sign(p: ReadonlyArray<readonly [number, number, number]>): number {
  const [n1, n2, n3, n4] = p;
  const a = [n2[0] - n1[0], n2[1] - n1[1], n2[2] - n1[2]];
  const b = [n3[0] - n1[0], n3[1] - n1[1], n3[2] - n1[2]];
  const c = [n4[0] - n1[0], n4[1] - n1[1], n4[2] - n1[2]];
  const det =
    a[0] * (b[1] * c[2] - b[2] * c[1]) -
    a[1] * (b[0] * c[2] - b[2] * c[0]) +
    a[2] * (b[0] * c[1] - b[1] * c[0]);
  return Math.sign(det);
}

/** A single tetrahedral center C(a0)–F,Cl,Br,I; alternating cube vertices = tetrahedron. */
function chiralCenter(id: string, handedness: 1 | -1, drawnStyle: "wedge" | "hashed" = "wedge") {
  const verts: Array<[number, number, number]> =
    handedness === 1
      ? [
          [1, 1, 1],
          [-1, -1, 1],
          [-1, 1, -1],
          [1, -1, -1]
        ]
      : [
          [1, 1, 1],
          [-1, -1, 1],
          [1, -1, -1],
          [-1, 1, -1]
        ];
  const coords3d = [0, 0, 0, ...verts.flat()];
  const mol = molecule(
    id,
    [
      { id: "a0", element: "C", x: 0, y: 0 },
      { id: "a1", element: "F", x: verts[0][0], y: verts[0][1] },
      { id: "a2", element: "Cl", x: verts[1][0], y: verts[1][1] },
      { id: "a3", element: "Br", x: verts[2][0], y: verts[2][1] },
      { id: "a4", element: "I", x: verts[3][0], y: verts[3][1] }
    ],
    [
      { id: "b1", from: "a0", to: "a1", style: drawnStyle },
      { id: "b2", from: "a0", to: "a2" },
      { id: "b3", from: "a0", to: "a3" },
      { id: "b4", from: "a0", to: "a4" }
    ]
  );
  return { mol, coords3d };
}

function achiralFormaldehyde(): CorpusCase {
  const mol = molecule(
    "corpus_achiral",
    [
      { id: "a0", element: "C", x: 0, y: 0 },
      { id: "a1", element: "O", x: 0, y: 1 },
      { id: "a2", element: "H", x: -1, y: -1 },
      { id: "a3", element: "H", x: 1, y: -1 }
    ],
    [
      { id: "b1", from: "a0", to: "a1", order: "double" },
      { id: "b2", from: "a0", to: "a2" },
      { id: "b3", from: "a0", to: "a3" }
    ]
  );
  return {
    id: "achiral-formaldehyde",
    family: "achiral",
    description: "Planar fragment, no specified stereo → clean commit, no wedges, no crossings.",
    label: "mustCommit",
    mol,
    coords3d: [0, 0, 0, 0, 1, 0, -1, -1, 0, 1, -1, 0],
    viewMatrix: IDENTITY
  };
}

function unspecifiedNotInvented(): CorpusCase {
  const { mol, coords3d } = chiralCenter("corpus_unspecified", 1);
  const stripped: MoleculeObject = { ...mol, bonds: mol.bonds.map((b) => ({ ...b, display: undefined })) };
  return {
    id: "unspecified-not-invented",
    family: "adversarial",
    description: "3D has a handedness but the drawing specifies no stereo → must stay plain.",
    label: "mustCommit",
    mol: stripped,
    coords3d,
    viewMatrix: IDENTITY
  };
}

function vicinalCsp(): CorpusCase {
  const coords: Record<string, [number, number, number]> = {
    a0: [0, 0, 0],
    a1: [-0.333, 0, 0.943],
    a2: [-0.333, -0.816, -0.471],
    a3: [1.5, 0, 0],
    a4: [-0.333, 0.816, -0.471],
    a5: [1.833, -0.816, 0.471],
    a6: [1.833, 0, -0.943],
    a7: [1.833, 0.816, 0.471]
  };
  const order = ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7"];
  const coords3d = order.flatMap((id) => coords[id]);
  const elements: Record<string, string> = {
    a0: "C", a1: "F", a2: "Cl", a3: "C", a4: "Br", a5: "F", a6: "Cl", a7: "Br"
  };
  const atoms: AtomSpec[] = order.map((id) => ({ id, element: elements[id], x: coords[id][0], y: coords[id][1] }));
  const bondIdFor: Record<string, string> = {
    "a0-a1": "b01", "a0-a2": "b02", "a0-a3": "b03", "a0-a4": "b04",
    "a3-a5": "b35", "a3-a6": "b36", "a3-a7": "b37"
  };
  const authorWedge = (center: string, neighborIdsSorted: string[]) => {
    const conformerSign = parity4Sign(neighborIdsSorted.map((id) => coords[id]));
    const wedgeNeighbor = [...neighborIdsSorted].sort(
      (a, b) => Math.abs(coords[b][2] - coords[center][2]) - Math.abs(coords[a][2] - coords[center][2])
    )[0];
    const drawnSign = parity4Sign(
      neighborIdsSorted.map((id) =>
        id === wedgeNeighbor
          ? ([coords[id][0], coords[id][1], 1] as [number, number, number])
          : ([coords[id][0], coords[id][1], 0] as [number, number, number])
      )
    );
    return {
      bondId: bondIdFor[`${center}-${wedgeNeighbor}`],
      style: (drawnSign === conformerSign ? "wedge" : "hashed") as "wedge" | "hashed"
    };
  };
  const c1 = authorWedge("a0", ["a1", "a2", "a3", "a4"]);
  const c2 = authorWedge("a3", ["a0", "a5", "a6", "a7"]);
  const styleByBond: Record<string, "wedge" | "hashed"> = { [c1.bondId]: c1.style, [c2.bondId]: c2.style };
  const bonds: BondSpec[] = (
    [
      { id: "b01", from: "a0", to: "a1" },
      { id: "b02", from: "a0", to: "a2" },
      { id: "b03", from: "a0", to: "a3" },
      { id: "b04", from: "a0", to: "a4" },
      { id: "b35", from: "a3", to: "a5" },
      { id: "b36", from: "a3", to: "a6" },
      { id: "b37", from: "a3", to: "a7" }
    ] as BondSpec[]
  ).map((b) => (styleByBond[b.id] ? { ...b, style: styleByBond[b.id] } : b));
  return {
    id: "vicinal-csp",
    family: "vicinal / meso",
    description: "Two adjacent specified centers sharing the C–C bond → CSP gives each a distinct wedge.",
    label: "mustCommit",
    mol: molecule("corpus_vicinal", atoms, bonds),
    coords3d,
    viewMatrix: IDENTITY
  };
}

function crossingWeave(): CorpusCase {
  const mol = molecule(
    "corpus_weave",
    [
      { id: "a0", element: "C", x: 0, y: 0 },
      { id: "a1", element: "C", x: 2, y: 2 },
      { id: "a2", element: "C", x: 0, y: 2 },
      { id: "a3", element: "C", x: 2, y: 0 }
    ],
    [
      { id: "b1", from: "a0", to: "a1" },
      { id: "bridge", from: "a1", to: "a2" },
      { id: "b2", from: "a2", to: "a3" }
    ]
  );
  return {
    id: "crossing-weave",
    family: "projection-weave",
    description: "Two bonds cross in projection; nearer-z bond becomes front → clean commit + baked crossing.",
    label: "mustCommit",
    mol,
    coords3d: [0, 0, 0, 2, 2, 0, 0, 2, 1, 2, 0, 1],
    viewMatrix: IDENTITY
  };
}

function ezEdgeOn(): CorpusCase {
  const mol = molecule(
    "corpus_ez",
    [
      { id: "a0", element: "C", x: 0, y: 0 },
      { id: "a1", element: "C", x: 2, y: 0 },
      { id: "a2", element: "Cl", x: -0.95, y: 0.08 },
      { id: "a3", element: "Cl", x: 2.95, y: -0.08 }
    ],
    [
      { id: "b1", from: "a0", to: "a1", order: "double" },
      { id: "b2", from: "a0", to: "a2" },
      { id: "b3", from: "a1", to: "a3" }
    ]
  );
  return {
    id: "ez-edge-on",
    family: "E/Z",
    description: "C=C substituents nearly collinear with the axis → never wedged, warns ez-edge-on.",
    label: "warnButAllow",
    mol,
    coords3d: [0, 0, 0, 2, 0, 0, -0.95, 0.08, 0, 2.95, -0.08, 0],
    viewMatrix: IDENTITY,
    expectWarnings: ["ez-edge-on"]
  };
}

function cyclicDepthEscher(): CorpusCase {
  const mol = molecule(
    "corpus_escher",
    [
      { id: "a0", element: "C", x: -5, y: 0 },
      { id: "a1", element: "C", x: 5, y: 2 },
      { id: "a2", element: "C", x: -5, y: 2 },
      { id: "a3", element: "C", x: 5, y: 0 },
      { id: "a4", element: "C", x: -5, y: 1.5 },
      { id: "a5", element: "C", x: 5, y: 1.5 }
    ],
    [
      { id: "A", from: "a0", to: "a1" },
      { id: "B", from: "a2", to: "a3" },
      { id: "C", from: "a4", to: "a5" }
    ]
  );
  return {
    id: "cyclic-depth-escher",
    family: "cyclic-depth / Escher",
    description: "Three crossings with inconsistent pairwise fronts (A>B>C>A) → warn, offer re-spin.",
    label: "warnButAllow",
    mol,
    coords3d: [-5, 0, 0, 5, 2, 0, -5, 2, -1, 5, 0, -1, -5, 1.5, -4, 5, 1.5, 2],
    viewMatrix: IDENTITY,
    expectWarnings: ["cyclic-depth"]
  };
}

function conformerContradictsDrawn(): CorpusCase {
  const { mol, coords3d } = chiralCenter("corpus_contradict", 1, "hashed");
  return {
    id: "conformer-contradicts-drawn",
    family: "adversarial",
    description: "3D handedness (+1) contradicts a hashed drawn marker → refuse (correlated-failure guard).",
    label: "mustRefuse",
    mol,
    coords3d,
    viewMatrix: IDENTITY,
    expectRefusalMatch: /contradicts the drawn wedge/
  };
}

function specifiedCenterEdgeOn(): CorpusCase {
  const { mol, coords3d } = chiralCenter("corpus_edgeon", 1);
  return {
    id: "specified-center-edge-on",
    family: "adversarial",
    description: "Specified center viewed edge-on (y squashed) → no legible sound wedge → refuse.",
    label: "mustRefuse",
    mol,
    coords3d,
    viewMatrix: Y_SQUASH,
    expectRefusalMatch: /edge-on/
  };
}

export const CORPUS: readonly CorpusCase[] = [
  achiralFormaldehyde(),
  chiralCenterCase("single-center-pos", 1),
  chiralCenterCase("single-center-neg", -1),
  unspecifiedNotInvented(),
  vicinalCsp(),
  crossingWeave(),
  ezEdgeOn(),
  cyclicDepthEscher(),
  conformerContradictsDrawn(),
  specifiedCenterEdgeOn()
];

function chiralCenterCase(id: string, handedness: 1 | -1): CorpusCase {
  const { mol, coords3d } = chiralCenter(`corpus_${id}`, handedness);
  return {
    id,
    family: "tetrahedral",
    description: `Single specified tetrahedral center, handedness ${handedness} → clean commit with one sound wedge.`,
    label: "mustCommit",
    mol,
    coords3d,
    viewMatrix: IDENTITY
  };
}
