/**
 * Method contracts for everything the RDKit adapter computes (PLANS.md §10).
 *
 * One contract per public number: its exact implementation and version, the interpretation it defaults
 * to, its units, the conventions it chose, the chemistry it covers, the conditions under which it
 * declines, and what obliges a version bump. Documentation, tooltips, the provenance report, and the
 * acknowledgements view all read from here, which is what stops the UI and the science drifting apart.
 *
 * Two things worth reading before editing:
 *
 * **Nearly every descriptor here is convention-dependent, and that is the honest finding.** Ring counts
 * go through SSSR; rotatable bonds, HBD/HBA, amide bonds, spiro and bridgehead atoms are SMARTS
 * definitions; kappa, chi, and Hall–Kier alpha are specific published formulations; even average mass
 * depends on the standard atomic weights in force. The schema refuses a convention-dependent contract
 * that does not name its conventions, so each one below says which rule it took.
 *
 * **`parameterizedElements` is the decline rule.** Crippen assigns every atom an atom type, so an
 * element outside the Wildman–Crippen tables silently takes a fallback contribution: RDKit reports
 * logP −2.95 for sodium benzoate against +0.05 for the benzoate anion, a three-log-unit swing produced
 * entirely by sodium. Ertl TPSA carries the same set for a different reason — its fragment table covers
 * organic N/O/S/P environments, and a TPSA of 0 that means "no polar atoms" is indistinguishable from
 * one that means "the polar atoms were unrecognised".
 */
import type { Classification, CitationRef, MethodContract, UnitId } from "@chemdraft/analysis-core";

/** The RDKit build these contracts were written against. A live engine reporting anything else warns. */
export const PINNED_RDKIT_VERSION = "2026.03.3";

/**
 * SHA-256 of `vendor/RDKit_minimal.wasm`, recorded in `vendor/BUILD.md`. Carried into every
 * `AnalysisRun`'s engine environment so a rebuilt artifact changes the run fingerprint and invalidates
 * cached numbers. `methods.test.ts` pins it against BUILD.md *and* against the bytes on disk, so
 * neither the prose nor this constant can drift from the artifact they describe.
 */
/**
 * SHA-256 over the vendored pKa artifacts the RUNTIME loads.
 *
 * Defined as sha256 of the lines `${filename}  ${sha256hex}\n`, filenames sorted — so one constant
 * covers the whole set, and the test that checks it can name whichever file moved. Test fixtures are
 * deliberately absent: they gate the build, they do not produce a number.
 *
 * These files decide every pKa the app reports — the trained network, its interval calibration, the
 * consensus weighting, the electrostatic coupling constant, the per-rung weighting the macroscopic
 * fold solves with, and the Hammett sigma table — and none of them reached any run fingerprint. Two builds could differ numerically and report identical
 * provenance, which is the one thing a fingerprint exists to prevent.
 *
 * Hashed at build time rather than at load: `analysisHash` is a BigInt-multiply-per-character FNV-1a
 * and the forest is 3.6 MB, and `node:crypto` does not exist in the worker this runs in.
 *
 * Recorded three ways on purpose, matching the wasm pin: this constant, the prose in
 * `vendor/pka-model/BUILD.md`, and the bytes on disk. `methods.test.ts` checks all three against each
 * other, so no two can drift without failing.
 */
export const PINNED_PKA_MODEL_SHA256 =
  "13757541703304372bf2aaf0ccba19e14bf62bbc98e9bd92878e6aa5cfa18ac5";

export const PINNED_RDKIT_WASM_SHA256 = "48b725a2e80af7f9792cd56abf65f16cea402f1cfe4f3f6c32a71669f1d848aa";

const ENGINE = "rdkit-minimallib-wasm";

/**
 * What the *loaded* artifact can do, as opposed to what the patch set says it should.
 *
 * The committed `RDKit_minimal.wasm` now carries vendor patch #6, but detection still compares
 * **values**, never arity, and the measurement that forced that is worth keeping: on the pre-rebuild
 * binary, `get_descriptors('{"includeSandP":true}')` did not throw — the extra argument was silently
 * ignored and `CS(=O)(=O)C` returned tpsa 34.14 either way. Arity detection would have reported the
 * patch as present and labelled an S-excluded number with the S-included convention, which is exactly
 * the silent-wrong-provenance failure this design exists to prevent. Any future artifact that lags the
 * patch set — a stale checkout, a partial rebuild — fails the same way, so the value probe stays.
 */
export interface RdkitEngineCapabilities {
  /** True when the loaded artifact honours the TPSA `includeSandP` details flag (vendor patch #6). */
  descriptorIncludeSandP: boolean;
}

/**
 * The conservative floor: the least-capable binary this adapter supports. Used as the assumed set
 * before `detectEngineCapabilities` has run, and as the fallback when the probe itself throws — never
 * as a claim about what the currently committed artifact can do.
 */
export const UNPATCHED_CAPABILITIES: RdkitEngineCapabilities = { descriptorIncludeSandP: false };

/** The details JSON patch #6 adds to `get_descriptors`. */
export const DESCRIPTOR_DETAILS_INCLUDE_SANDP = '{"includeSandP":true}';

/**
 * A sulfone: its TPSA differs between the two conventions, so a value comparison on it distinguishes
 * a patched binding from one that ignored the argument. A structure without S or P could not.
 */
export const INCLUDE_SANDP_PROBE_SMILES = "CS(=O)(=O)C";

/** Elements the Wildman–Crippen atom-contribution tables and the Ertl TPSA fragments actually cover. */
export const ORGANIC_PARAMETER_SET = ["H", "C", "N", "O", "S", "P", "F", "Cl", "Br", "I"];

const CITATIONS = {
  rdkit: {
    id: "rdkit",
    kind: "software",
    title: "RDKit: Open-source cheminformatics",
    authors: "Greg Landrum and contributors",
    version: PINNED_RDKIT_VERSION,
    url: "https://www.rdkit.org/"
  },
  ertl: {
    id: "ertl-2000",
    kind: "journal",
    title:
      "Fast Calculation of Molecular Polar Surface Area as a Sum of Fragment-Based Contributions and Its " +
      "Application to the Prediction of Drug Transport Properties",
    authors: "Peter Ertl, Bernhard Rohde, Paul Selzer",
    year: 2000
  },
  crippen: {
    id: "wildman-crippen-1999",
    kind: "journal",
    title: "Prediction of Physicochemical Parameters by Atomic Contributions",
    authors: "Scott A. Wildman, Gordon M. Crippen",
    year: 1999
  },
  labute: {
    id: "labute-2000",
    kind: "journal",
    title: "A widely applicable set of descriptors",
    authors: "Paul Labute",
    year: 2000
  },
  kierHallShape: {
    id: "kier-1985",
    kind: "journal",
    title: "A shape index from molecular graphs",
    authors: "Lemont B. Kier",
    year: 1985
  },
  kierHallConnectivity: {
    id: "kier-hall-1976",
    kind: "book",
    title: "Molecular Connectivity in Chemistry and Drug Research",
    authors: "Lemont B. Kier, Lowell H. Hall",
    year: 1976
  },
  lipinski: {
    id: "lipinski-1997",
    kind: "journal",
    title:
      "Experimental and computational approaches to estimate solubility and permeability in drug discovery " +
      "and development settings",
    authors: "Christopher A. Lipinski, Franco Lombardo, Beryl W. Dominy, Paul J. Feeney",
    year: 1997
  },
  inchi: {
    id: "inchi-trust",
    kind: "specification",
    title: "IUPAC International Chemical Identifier (InChI)",
    authors: "InChI Trust",
    version: "1.07.3"
  }
} as const satisfies Record<string, CitationRef>;

// --- the descriptor table ------------------------------------------------------------------------

interface DescriptorSpec {
  id: string;
  publicName: string;
  /** Key in `get_descriptors()`'s JSON. */
  descriptorKey: string;
  unit: UnitId;
  conventions: string[];
  decimalPlaces?: number;
  parameterizedElements?: string[];
  citations?: CitationRef[];
  claim?: MethodContract["claim" extends never ? never : "classification"]["claim"];
  experimentallyCalibrated?: boolean;
  derivation?: MethodContract["classification"]["derivation"];
  declinesWhen?: string[];
  knownUnsupportedChemistry?: string[];
  versionIncrementTriggers?: string[];
}

const COUNT_CONVENTION_TOPOLOGICAL =
  "never on element grounds — a graph count with no element parameterisation; it declines only when the " +
  "structure fails to parse or sanitise";

const SSSR = "ring perception via RDKit's symmetrised smallest set of smallest rings (SSSR)";

const DESCRIPTORS: DescriptorSpec[] = [
  {
    id: "rdkit.tpsa",
    publicName: "Topological polar surface area (TPSA)",
    descriptorKey: "tpsa",
    unit: "square-angstrom",
    decimalPlaces: 2,
    conventions: [
      "Ertl 2000 fragment contributions",
      "sulfur and phosphorus EXCLUDED (RDKit's includeSandP default of false) — every sulfonamide and " +
        "phosphate therefore reads low against implementations that include them"
    ],
    parameterizedElements: ORGANIC_PARAMETER_SET,
    citations: [CITATIONS.ertl, CITATIONS.rdkit],
    declinesWhen: [
      "the structure contains an element outside the Ertl organic parameter set, because a TPSA of 0 " +
        'meaning "no polar atoms" cannot be told apart from one meaning "the polar atoms were unrecognised"'
    ],
    knownUnsupportedChemistry: ["boron", "silicon", "metals", "coordination compounds"],
    versionIncrementTriggers: [
      "exposing includeSandP (vendor patch #6) — the number changes for every S/P structure",
      "an RDKit release that alters the Ertl fragment tables"
    ]
  },
  {
    id: "rdkit.crippen-logp",
    publicName: "Crippen logP",
    descriptorKey: "CrippenClogP",
    unit: "log10-unit",
    decimalPlaces: 2,
    conventions: [
      "Wildman–Crippen atom-contribution model",
      "computed on the interpretation as given — no implicit neutralisation or desalting"
    ],
    parameterizedElements: ORGANIC_PARAMETER_SET,
    citations: [CITATIONS.crippen, CITATIONS.rdkit],
    claim: "prediction",
    derivation: "fragment-rule",
    experimentallyCalibrated: true,
    declinesWhen: [
      "the structure contains an element outside the Wildman–Crippen tables, which would otherwise take a " +
        "fallback atom contribution — sodium benzoate reads −2.95 against the benzoate anion's +0.05"
    ],
    knownUnsupportedChemistry: ["boron", "silicon", "metals", "salts as drawn", "organometallics"],
    versionIncrementTriggers: ["an RDKit release that alters the Crippen parameter file"]
  },
  {
    id: "rdkit.crippen-mr",
    publicName: "Crippen molar refractivity",
    descriptorKey: "CrippenMR",
    unit: "cubic-centimetre-per-mole",
    decimalPlaces: 2,
    conventions: ["Wildman–Crippen atom-contribution model"],
    parameterizedElements: ORGANIC_PARAMETER_SET,
    citations: [CITATIONS.crippen, CITATIONS.rdkit],
    claim: "prediction",
    derivation: "fragment-rule",
    experimentallyCalibrated: true,
    declinesWhen: ["the structure contains an element outside the Wildman–Crippen tables"],
    knownUnsupportedChemistry: ["boron", "silicon", "metals", "organometallics"],
    versionIncrementTriggers: ["an RDKit release that alters the Crippen parameter file"]
  },
  {
    id: "rdkit.rotatable-bonds",
    publicName: "Rotatable bonds",
    descriptorKey: "NumRotatableBonds",
    unit: "count",
    conventions: [
      "RDKit's strict rotatable-bond SMARTS: single, non-ring, between two heavy atoms each with further " +
        "heavy-atom neighbours; amide C–N bonds excluded",
      "OpenChemLib's definition disagrees in BOTH directions — 3 vs 2 on aspirin, 2 vs 3 on " +
        "sulfamethoxazole — so the count is a property of the rule, not of the molecule"
    ],
    citations: [CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.hbd",
    publicName: "Hydrogen-bond donors",
    descriptorKey: "NumHBD",
    unit: "count",
    conventions: ["RDKit's donor definition (N–H and O–H), not the Lipinski heavy-atom count"],
    citations: [CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.hba",
    publicName: "Hydrogen-bond acceptors",
    descriptorKey: "NumHBA",
    unit: "count",
    conventions: ["RDKit's acceptor definition, which excludes several N and O environments Lipinski counts"],
    citations: [CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.lipinski-hbd",
    publicName: "Lipinski hydrogen-bond donors",
    descriptorKey: "lipinskiHBD",
    unit: "count",
    conventions: ["Lipinski's rule-of-five counting: N–H and O–H hydrogens"],
    citations: [CITATIONS.lipinski, CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.lipinski-hba",
    publicName: "Lipinski hydrogen-bond acceptors",
    descriptorKey: "lipinskiHBA",
    unit: "count",
    conventions: ["Lipinski's rule-of-five counting: every nitrogen and oxygen"],
    citations: [CITATIONS.lipinski, CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.heavy-atom-count",
    publicName: "Heavy atoms",
    descriptorKey: "NumHeavyAtoms",
    unit: "count",
    conventions: ["all non-hydrogen atoms, counted across every component of the interpretation"],
    citations: [CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.heteroatom-count",
    publicName: "Heteroatoms",
    descriptorKey: "NumHeteroatoms",
    unit: "count",
    conventions: ["every atom that is neither carbon nor hydrogen — metals and metalloids included"],
    citations: [CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.amide-bond-count",
    publicName: "Amide bonds",
    descriptorKey: "NumAmideBonds",
    unit: "count",
    conventions: ["RDKit's amide SMARTS; sulfonamides and phosphoramides are not counted"],
    citations: [CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.fraction-csp3",
    publicName: "Fraction of sp³ carbons (Fsp³)",
    descriptorKey: "FractionCSP3",
    unit: "fraction",
    decimalPlaces: 3,
    conventions: ["sp³ carbons ÷ total carbons, using RDKit's hybridisation perception; zero carbons gives 0"],
    citations: [CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.ring-count",
    publicName: "Rings",
    descriptorKey: "NumRings",
    unit: "count",
    conventions: [SSSR],
    citations: [CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.aromatic-ring-count",
    publicName: "Aromatic rings",
    descriptorKey: "NumAromaticRings",
    unit: "count",
    conventions: [SSSR, "aromaticity by RDKit's default model, which differs from the Daylight and MDL models"],
    citations: [CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.aliphatic-ring-count",
    publicName: "Aliphatic rings",
    descriptorKey: "NumAliphaticRings",
    unit: "count",
    conventions: [SSSR, "aromaticity by RDKit's default model"],
    citations: [CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.saturated-ring-count",
    publicName: "Saturated rings",
    descriptorKey: "NumSaturatedRings",
    unit: "count",
    conventions: [SSSR, "a ring is saturated when every ring atom is sp³"],
    citations: [CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.heterocycle-count",
    publicName: "Heterocycles",
    descriptorKey: "NumHeterocycles",
    unit: "count",
    conventions: [SSSR],
    citations: [CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.aromatic-heterocycle-count",
    publicName: "Aromatic heterocycles",
    descriptorKey: "NumAromaticHeterocycles",
    unit: "count",
    conventions: [SSSR, "aromaticity by RDKit's default model"],
    citations: [CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.saturated-heterocycle-count",
    publicName: "Saturated heterocycles",
    descriptorKey: "NumSaturatedHeterocycles",
    unit: "count",
    conventions: [SSSR, "a ring is saturated when every ring atom is sp³"],
    citations: [CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.aliphatic-heterocycle-count",
    publicName: "Aliphatic heterocycles",
    descriptorKey: "NumAliphaticHeterocycles",
    unit: "count",
    conventions: [SSSR, "aromaticity by RDKit's default model"],
    citations: [CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.spiro-atom-count",
    publicName: "Spiro atoms",
    descriptorKey: "NumSpiroAtoms",
    unit: "count",
    conventions: [SSSR, "an atom shared by exactly two rings that share no bond"],
    citations: [CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.bridgehead-atom-count",
    publicName: "Bridgehead atoms",
    descriptorKey: "NumBridgeheadAtoms",
    unit: "count",
    conventions: [SSSR, "an atom shared by two rings that share at least one bond"],
    citations: [CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.atom-stereocentre-count",
    publicName: "Atom stereocentres",
    descriptorKey: "NumAtomStereoCenters",
    unit: "count",
    conventions: ["RDKit's stereocentre perception; potential centres with no assignment count separately"],
    citations: [CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.unspecified-atom-stereocentre-count",
    publicName: "Unspecified atom stereocentres",
    descriptorKey: "NumUnspecifiedAtomStereoCenters",
    unit: "count",
    conventions: ["potential stereocentres carrying no wedge, hash, or SMILES chirality tag"],
    citations: [CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.labute-asa",
    publicName: "Labute approximate surface area",
    descriptorKey: "labuteASA",
    unit: "square-angstrom",
    decimalPlaces: 2,
    conventions: ["Labute's connectivity-based ASA approximation over per-element radii — not a computed surface"],
    citations: [CITATIONS.labute, CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.hall-kier-alpha",
    publicName: "Hall–Kier alpha",
    descriptorKey: "hallKierAlpha",
    unit: "dimensionless",
    decimalPlaces: 3,
    conventions: ["Hall–Kier atom-type alpha contributions relative to sp³ carbon"],
    citations: [CITATIONS.kierHallShape, CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.kappa1",
    publicName: "Kappa 1 shape index",
    descriptorKey: "kappa1",
    unit: "dimensionless",
    decimalPlaces: 3,
    conventions: ["Kier first-order shape index, alpha-corrected"],
    citations: [CITATIONS.kierHallShape, CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.kappa2",
    publicName: "Kappa 2 shape index",
    descriptorKey: "kappa2",
    unit: "dimensionless",
    decimalPlaces: 3,
    conventions: ["Kier second-order shape index, alpha-corrected"],
    citations: [CITATIONS.kierHallShape, CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.kappa3",
    publicName: "Kappa 3 shape index",
    descriptorKey: "kappa3",
    unit: "dimensionless",
    decimalPlaces: 3,
    conventions: ["Kier third-order shape index, alpha-corrected"],
    citations: [CITATIONS.kierHallShape, CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  {
    id: "rdkit.phi",
    publicName: "Kier flexibility index (Phi)",
    descriptorKey: "Phi",
    unit: "dimensionless",
    decimalPlaces: 3,
    conventions: ["kappa1 × kappa2 ÷ heavy-atom count"],
    citations: [CITATIONS.kierHallShape, CITATIONS.rdkit],
    declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
  },
  ...(["0", "1", "2", "3", "4"] as const).flatMap((order) =>
    (["n", "v"] as const).map((flavour) => ({
      id: `rdkit.chi${order}${flavour}`,
      publicName: `Chi ${order} ${flavour === "n" ? "(simple)" : "(valence)"} connectivity index`,
      descriptorKey: `chi${order}${flavour}`,
      unit: "dimensionless" as UnitId,
      decimalPlaces: 3,
      conventions: [
        `Kier–Hall ${flavour === "n" ? "simple" : "valence"} connectivity index of order ${order}`
      ],
      citations: [CITATIONS.kierHallConnectivity, CITATIONS.rdkit],
      declinesWhen: [COUNT_CONVENTION_TOPOLOGICAL]
    }))
  )
];

// --- contract construction ------------------------------------------------------------------------

const DEFAULT_VERSION_TRIGGERS = [
  "an RDKit release that changes this method's implementation",
  "any change to the parameters recorded in implementation.parameters"
];

/**
 * Real-valued descriptors are sums over per-atom or per-fragment contributions, so the order the atoms
 * arrive in changes the final floating-point bit. Measured, not assumed: aspirin's TPSA is
 * 63.60000000000001 written one way and 63.6 written another — a 7.1e-15 difference the
 * representation-invariance harness caught on its first run. It is a property of summation, not a
 * defect, so it is stated here and the invariance suite compares real values to 1e-9.
 */
const SUMMATION_ORDER_CONVENTION =
  "summed over per-atom or per-fragment contributions, so the last floating-point bit depends on atom " +
  "ordering; representations of one molecule agree to within 1e-9, not exactly";

function descriptorContract(spec: DescriptorSpec, engineVersion: string): MethodContract {
  const experimentallyCalibrated = spec.experimentallyCalibrated ?? false;
  const conventions =
    spec.decimalPlaces === undefined ? spec.conventions : [...spec.conventions, SUMMATION_ORDER_CONVENTION];
  return {
    id: spec.id,
    publicName: spec.publicName,
    version: "1.0.0",
    implementation: {
      engine: ENGINE,
      engineVersion,
      symbol: `JSMol::get_descriptors.${spec.descriptorKey}`,
      // `includeSandP` is recorded on every descriptor, not just TPSA, because it is a property of the
      // binding rather than of one number — patch #6 changes the binding, and the cache key must move
      // for anything computed through it.
      parameters: { descriptor: spec.descriptorKey, includeSandP: false }
    },
    defaultInterpretationId: "source",
    resultKind: "scalar",
    unit: spec.unit,
    conventions,
    classification: {
      derivation: spec.derivation ?? "graph-derived",
      claim: spec.claim ?? "descriptor",
      determinism: "deterministic",
      flags: {
        // Everything in this table depends on a named rule; that is why each entry states one.
        conventionDependent: true,
        experimentallyCalibrated,
        trainedOnExperimentalData: false
      }
    },
    supportedChemistry: spec.parameterizedElements
      ? [`organic structures over ${spec.parameterizedElements.join(", ")}`]
      : ["any structure RDKit parses and sanitises"],
    knownUnsupportedChemistry: spec.knownUnsupportedChemistry ?? [],
    ...(spec.parameterizedElements ? { parameterizedElements: spec.parameterizedElements } : {}),
    declinesWhen: spec.declinesWhen ?? [COUNT_CONVENTION_TOPOLOGICAL],
    accuracyClaims: [],
    citations: [...(spec.citations ?? [CITATIONS.rdkit])],
    datasets: [],
    versionIncrementTriggers: spec.versionIncrementTriggers ?? DEFAULT_VERSION_TRIGGERS,
    tautomerSensitive: false
  };
}

/** Descriptor id → the `get_descriptors()` key it reads, and how many decimals it can defend. */
export interface DescriptorBinding {
  methodId: string;
  descriptorKey: string;
  decimalPlaces?: number;
}

export function descriptorBindings(): DescriptorBinding[] {
  return [
    // The two masses read `get_descriptors()` like everything else; they sit outside the DESCRIPTORS
    // table only because their contracts carry mass-specific conventions. Their decimal places are the
    // precision the values are conventionally quoted to — reporting RDKit's full float
    // (144.01872368000002) would claim significance the engine's own atomic masses do not have.
    { methodId: "rdkit.average-mass", descriptorKey: "amw", decimalPlaces: 3 },
    { methodId: "rdkit.monoisotopic-mass", descriptorKey: "exactmw", decimalPlaces: 5 },
    ...DESCRIPTORS.map((spec) => ({
      methodId: spec.id,
      descriptorKey: spec.descriptorKey,
      ...(spec.decimalPlaces !== undefined ? { decimalPlaces: spec.decimalPlaces } : {})
    }))
  ];
}

/**
 * Every contract the adapter can run, built against a live engine version.
 *
 * The version is a parameter rather than a constant so a rebuilt WASM flows into `methodKey` — and
 * therefore into every cache key — without anyone remembering to edit a literal.
 */
export function rdkitMethodContracts(
  engineVersion: string = PINNED_RDKIT_VERSION,
  capabilities: RdkitEngineCapabilities = UNPATCHED_CAPABILITIES
): MethodContract[] {
  const nonDescriptor: MethodContract[] = [
    {
      id: "rdkit.composition",
      publicName: "Composition",
      version: "1.0.0",
      implementation: {
        engine: ENGINE,
        engineVersion,
        symbol: "JSMol::get_json",
        parameters: { hillNotation: true, separateIsotopes: true }
      },
      defaultInterpretationId: "source",
      resultKind: "composition",
      conventions: [
        "Hill notation: carbon, then hydrogen, then every other element alphabetically; with no carbon, all elements alphabetically",
        "isotope-labelled atoms are written [13C] and listed before the natural-abundance atoms of the same element",
        "implicit hydrogens are protium and never inherit their heavy atom's isotope label",
        "identical components collapse into a multiplicity, so N.N.Cl[Pt]Cl reads as 2 × H3N + Cl2Pt"
      ],
      classification: {
        derivation: "graph-derived",
        claim: "composition",
        determinism: "deterministic",
        flags: { conventionDependent: true, experimentallyCalibrated: false, trainedOnExperimentalData: false }
      },
      supportedChemistry: ["any structure RDKit parses and sanitises"],
      knownUnsupportedChemistry: [],
      declinesWhen: ["never — composition is defined for any structure that parses and sanitises"],
      accuracyClaims: [],
      citations: [CITATIONS.rdkit],
      datasets: [],
      versionIncrementTriggers: [
        "any change to the Hill or isotope-rendering convention above",
        "an RDKit release that changes implicit-hydrogen perception"
      ],
      tautomerSensitive: false
    },
    {
      id: "rdkit.average-mass",
      publicName: "Average mass",
      version: "1.0.0",
      implementation: {
        engine: ENGINE,
        engineVersion,
        symbol: "JSMol::get_descriptors.amw",
        parameters: { descriptor: "amw" }
      },
      defaultInterpretationId: "source",
      resultKind: "scalar",
      unit: "gram-per-mole",
      conventions: [
        "abundance-weighted over RDKit's standard atomic weights — a convention IUPAC revises, not a constant",
        "an explicitly labelled position uses that isotope's mass rather than the element's weighted average",
        "reported in g/mol, which is NOT interchangeable with the monoisotopic mass in daltons"
      ],
      classification: {
        derivation: "convention",
        claim: "composition",
        determinism: "deterministic",
        flags: { conventionDependent: true, experimentallyCalibrated: false, trainedOnExperimentalData: false }
      },
      supportedChemistry: ["any structure RDKit parses and sanitises"],
      knownUnsupportedChemistry: [],
      declinesWhen: ["never — average mass is defined for any structure that parses and sanitises"],
      accuracyClaims: [],
      citations: [CITATIONS.rdkit],
      datasets: [],
      versionIncrementTriggers: ["an RDKit release that adopts revised standard atomic weights"],
      tautomerSensitive: false
    },
    {
      id: "rdkit.monoisotopic-mass",
      publicName: "Monoisotopic mass",
      version: "1.0.0",
      implementation: {
        engine: ENGINE,
        engineVersion,
        symbol: "JSMol::get_descriptors.exactmw",
        parameters: { descriptor: "exactmw" }
      },
      defaultInterpretationId: "source",
      resultKind: "scalar",
      unit: "dalton",
      conventions: [
        "the most abundant isotope of each element unless the atom carries an explicit label",
        "reported in daltons — the mass of one molecule, not a mole-weighted average"
      ],
      classification: {
        derivation: "convention",
        claim: "composition",
        determinism: "deterministic",
        flags: { conventionDependent: true, experimentallyCalibrated: false, trainedOnExperimentalData: false }
      },
      supportedChemistry: ["any structure RDKit parses and sanitises"],
      knownUnsupportedChemistry: [],
      declinesWhen: ["never — monoisotopic mass is defined for any structure that parses and sanitises"],
      accuracyClaims: [],
      citations: [CITATIONS.rdkit],
      datasets: [],
      versionIncrementTriggers: ["an RDKit release that adopts revised isotope masses"],
      tautomerSensitive: false
    },
    {
      id: "rdkit.inchi",
      publicName: "InChI",
      version: "1.0.0",
      implementation: {
        engine: ENGINE,
        engineVersion,
        symbol: "JSMol::get_inchi",
        parameters: { flavour: "standard", inchiSoftware: "1.07.3" }
      },
      defaultInterpretationId: "source",
      resultKind: "identifier",
      conventions: [
        "standard InChI — the normalisation, tautomer, and stereo layers are the InChI algorithm's conventions, not ChemDraft's",
        "generated by the InChI library statically linked into the vendored RDKit MinimalLib build"
      ],
      classification: {
        derivation: "convention",
        claim: "identity",
        determinism: "deterministic",
        flags: { conventionDependent: true, experimentallyCalibrated: false, trainedOnExperimentalData: false }
      },
      supportedChemistry: ["any structure the InChI library accepts, organometallics included"],
      knownUnsupportedChemistry: ["structures the InChI library rejects outright"],
      declinesWhen: ["the InChI library returns an empty string or throws"],
      accuracyClaims: [],
      citations: [CITATIONS.inchi, CITATIONS.rdkit],
      datasets: [],
      versionIncrementTriggers: ["an InChI software release that changes any normalisation layer"],
      tautomerSensitive: false
    },
    {
      id: "rdkit.inchikey",
      publicName: "InChIKey",
      version: "1.0.0",
      implementation: {
        engine: ENGINE,
        engineVersion,
        symbol: "RDKit::get_inchikey_for_inchi",
        parameters: { flavour: "standard", inchiSoftware: "1.07.3" }
      },
      defaultInterpretationId: "source",
      resultKind: "identifier",
      conventions: [
        "hash of the standard InChI above — a different InChI convention produces a different key",
        "a collision is possible in principle; the key is a lookup handle, not a proof of identity"
      ],
      classification: {
        derivation: "convention",
        claim: "identity",
        determinism: "deterministic",
        flags: { conventionDependent: true, experimentallyCalibrated: false, trainedOnExperimentalData: false }
      },
      supportedChemistry: ["any structure with a generated InChI"],
      knownUnsupportedChemistry: [],
      declinesWhen: ["no InChI was generated"],
      accuracyClaims: [],
      citations: [CITATIONS.inchi, CITATIONS.rdkit],
      datasets: [],
      versionIncrementTriggers: ["an InChI software release that changes the key derivation"],
      tautomerSensitive: false
    },
    {
      id: "rdkit.canonical-smiles",
      publicName: "Canonical SMILES",
      version: "1.0.0",
      implementation: {
        engine: ENGINE,
        engineVersion,
        symbol: "JSMol::get_smiles",
        parameters: { isomeric: true, canonical: true }
      },
      defaultInterpretationId: "source",
      resultKind: "identifier",
      conventions: [
        "RDKit's canonical ranking — canonical WITHIN RDKit only; other toolkits produce different strings for the same molecule",
        "isomeric: specified stereochemistry and isotope labels are written out"
      ],
      classification: {
        derivation: "convention",
        claim: "identity",
        determinism: "deterministic",
        flags: { conventionDependent: true, experimentallyCalibrated: false, trainedOnExperimentalData: false }
      },
      supportedChemistry: ["any structure RDKit parses and sanitises"],
      knownUnsupportedChemistry: [],
      declinesWhen: ["RDKit returns an empty string"],
      accuracyClaims: [],
      citations: [CITATIONS.rdkit],
      datasets: [],
      versionIncrementTriggers: ["an RDKit release that changes the canonical ranking algorithm"],
      tautomerSensitive: false
    }
  ];

  const descriptors = DESCRIPTORS.map((spec) => descriptorContract(spec, engineVersion));
  return [...nonDescriptor, ...descriptors.map((contract) => withCapabilities(contract, capabilities))];
}

/**
 * Rewrite a contract to describe what the loaded artifact actually did.
 *
 * TPSA is the only contract this touches today. Its own `versionIncrementTriggers` say that exposing
 * `includeSandP` bumps the version — so the bump happens here, when the capability is really present,
 * rather than being a literal someone has to remember to edit. The version is part of `methodKey`, so
 * a rebuilt artifact also invalidates every cached TPSA rather than serving S-excluded numbers under
 * the S-included convention.
 */
function withCapabilities(contract: MethodContract, capabilities: RdkitEngineCapabilities): MethodContract {
  if (contract.id !== "rdkit.tpsa") return contract;

  if (!capabilities.descriptorIncludeSandP) {
    return {
      ...contract,
      conventions: [
        ...contract.conventions,
        "the loaded artifact predates vendor patch #6, so this convention is not selectable — see packages/rdkit-adapter/vendor/BUILD.md"
      ]
    };
  }

  return {
    ...contract,
    version: "2.0.0",
    implementation: {
      ...contract.implementation,
      parameters: { ...contract.implementation.parameters, includeSandP: true }
    },
    conventions: [
      "Ertl 2000 fragment contributions",
      "sulfur and phosphorus INCLUDED (vendor patch #6 exposes RDKit's includeSandP) — sulfonamides and " +
        "phosphates therefore read higher than an implementation using RDKit's default of false",
      SUMMATION_ORDER_CONVENTION
    ]
  };
}
