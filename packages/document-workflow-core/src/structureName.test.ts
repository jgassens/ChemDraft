// This test stays beside its module so the policy contract is easy to audit. The purity boundary
// scans src imports as production dependencies, so use the workspace test runner by its local path.
import { afterEach, describe, expect, it, vi } from "../../../node_modules/vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";

import * as smilesExport from "./moleculeSmiles";
import {
  acceptOrthonymResult,
  nameStructure,
  verifyNameRoundTrip,
  type OrthonymRawResult,
  type StructureNameDeps
} from "./structureName";

afterEach(() => vi.restoreAllMocks());

const verified = (overrides: Partial<OrthonymRawResult> = {}): OrthonymRawResult => ({
  name: "ethanol",
  tier: "pin_verified",
  isPin: true,
  opsin: "verified",
  gateOutcome: "full_key_round_trip_verified",
  limitCode: null,
  stereoUnexpressed: false,
  source: "test",
  ...overrides
});

function molecule(overrides: Partial<MoleculeObject> = {}): MoleculeObject {
  return {
    id: "m1", type: "molecule", x: 0, y: 0, width: 20, height: 10,
    rotation: 0, style: {}, structureFormat: "smiles", structure: "CCO",
    atoms: [
      { id: "a1", element: "C", x: 0, y: 0, formalCharge: 0 },
      { id: "a2", element: "C", x: 10, y: 0, formalCharge: 0 },
      { id: "a3", element: "O", x: 20, y: 0, formalCharge: 0 }
    ],
    bonds: [
      { id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" },
      { id: "b2", fromAtomId: "a2", toAtomId: "a3", order: "single" }
    ],
    superatoms: [], rGroups: [],
    ...overrides
  };
}

function deps(overrides: Partial<StructureNameDeps> = {}): StructureNameDeps {
  return {
    canonicalize: vi.fn(async () => "CCO"),
    name: vi.fn(async () => verified()),
    readName: vi.fn(async () => ({ smiles: "CCO" })),
    ...overrides
  };
}

describe("acceptOrthonymResult", () => {
  it.each([
    ["preferred", verified(), { ok: true, kind: "preferredIupacName" }],
    ["systematic", verified({ tier: "systematic_verified", isPin: false }), { ok: true, kind: "systematicName" }],
    ["unverified tier", verified({ tier: "candidate" }), { ok: false, code: "notFullyVerified" }],
    ["unverified OPSIN", verified({ opsin: "failed" }), { ok: false, code: "notFullyVerified" }],
    ["carveout", verified({ gateOutcome: "carveout:known-gap" }), { ok: false, code: "notFullyVerified" }],
    ["unexpressed stereo", verified({ stereoUnexpressed: true }), { ok: false, code: "notFullyVerified" }],
    ["missing name", verified({ name: null }), { ok: false, code: "notFullyVerified" }],
    ["blank name", verified({ name: "  " }), { ok: false, code: "notFullyVerified" }],
    ["control character", verified({ name: "ethyl\n alcohol" }), { ok: false, code: "notFullyVerified" }],
    ["unsupported element", verified({ tier: "abstain", limitCode: "UNSUPPORTED_ELEMENT" }), { ok: false, code: "unsupportedElement", limitCode: "UNSUPPORTED_ELEMENT" }],
    ["unnameable", verified({ tier: "abstain", limitCode: "UNNAMEABLE" }), { ok: false, code: "unnameable", limitCode: "UNNAMEABLE" }],
    ["other engine limit", verified({ tier: "abstain", limitCode: "TOO_COMPLEX" }), { ok: false, code: "engineLimit", limitCode: "TOO_COMPLEX" }],
    ["unspecified engine limit", verified({ tier: "abstain", limitCode: null }), { ok: false, code: "engineLimit" }]
  ] as const)("%s follows the acceptance table", (_label, raw, expected) => {
    expect(acceptOrthonymResult(raw)).toMatchObject(expected);
  });

  it.each([
    verified({ tier: "candidate" }),
    verified({ tier: "abstain", limitCode: "UNSUPPORTED_ELEMENT" }),
    verified({ tier: "abstain", limitCode: "UNNAMEABLE" }),
    verified({ tier: "abstain", limitCode: "TOO_COMPLEX" })
  ])("keeps engine codes out of decline reasons", (raw) => {
    const result = acceptOrthonymResult(raw);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).not.toMatch(/\b(?:UNSUPPORTED_ELEMENT|UNNAMEABLE|TOO_COMPLEX)\b/);
  });
});

describe("verifyNameRoundTrip", () => {
  it("declines the glycine zwitterion when its name reads back as neutral glycine", async () => {
    await expect(verifyNameRoundTrip({
      drawnCanonicalSmiles: "[NH3+]CC(=O)[O-]",
      name: "glycine",
      readName: async () => ({ smiles: "NCC(=O)O" }),
      canonicalize: async (smiles) => smiles
    })).resolves.toMatchObject({ verified: false });
  });

  it.each(["[13CH3]O", "[CH3]"])("accepts an exact isotope or radical reading: %s", async (smiles) => {
    await expect(verifyNameRoundTrip({
      drawnCanonicalSmiles: smiles,
      name: "test name",
      readName: async () => ({ smiles }),
      canonicalize: async (input) => input
    })).resolves.toEqual({ verified: true });
  });

  it.each([
    ["cannot read name", async () => ({ smiles: null, failureReason: "OPSIN could not read the name." })],
    ["canonicalisation fails", async () => ({ smiles: "CCO" })]
  ])("declines when the name %s", async (label, readName) => {
    await expect(verifyNameRoundTrip({
      drawnCanonicalSmiles: "CCO",
      name: "ethanol",
      readName,
      canonicalize: async () => label === "canonicalisation fails" ? null : "CCO"
    })).resolves.toMatchObject({ verified: false });
  });
});

describe("nameStructure", () => {
  it("names an exact structure after the canonical-SMILES round trip", async () => {
    await expect(nameStructure(deps(), molecule())).resolves.toMatchObject({
      status: "named", name: "ethanol", kind: "preferredIupacName", warnings: []
    });
  });

  it("adds limited-evidence warning when canonical isomeric SMILES carries stereo", async () => {
    await expect(nameStructure(deps({ canonicalize: async () => "C[C@H](O)F" }), molecule())).resolves.toMatchObject({
      status: "named", warnings: [expect.objectContaining({ code: "stereoLimitedEvidence" })]
    });
  });

  it("keeps an abbreviation expansion as an informational naming warning", async () => {
    const abbreviated = molecule({
      atoms: [
        { id: "a1", element: "C", x: 0, y: 0, formalCharge: 0 },
        { id: "a2", element: "OMe", x: 10, y: 0, formalCharge: 0 }
      ],
      bonds: [{ id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" }]
    });
    await expect(nameStructure(deps({ canonicalize: async () => "COC", readName: async () => ({ smiles: "COC" }) }), abbreviated))
      .resolves.toMatchObject({ status: "named", warnings: [expect.objectContaining({ code: "abbreviationExpanded" })] });
  });

  it("declines an engine result that does not read back exactly", async () => {
    await expect(nameStructure(deps({ readName: async () => ({ smiles: "NCC(=O)O" }), canonicalize: async (input) =>
      input === "NCC(=O)O" ? "NCC(=O)O" : "[NH3+]CC(=O)[O-]"
    }), molecule())).resolves.toMatchObject({ status: "declined", code: "noVerifiedName" });
  });

  it.each(["Fe", "Sn"])('identifies unsupported element %s without exposing its engine code', async (element) => {
    const drawn = molecule({
      atoms: [{ id: "a1", element, x: 0, y: 0, formalCharge: 0 }],
      bonds: []
    });
    const result = await nameStructure(deps({
      name: async () => verified({ tier: "abstain", limitCode: "UNSUPPORTED_ELEMENT" })
    }), drawn);

    expect(result).toMatchObject({
      status: "declined",
      code: "unsupportedElement",
      limitCode: "UNSUPPORTED_ELEMENT",
      reason: `Contains an element the naming engine doesn't support (${element}).`
    });
  });

  it("treats deuterium and tritium as supported hydrogen isotopes", async () => {
    const drawn = molecule({
      atoms: [
        { id: "a1", element: "C", x: 0, y: 0, formalCharge: 0 },
        { id: "a2", element: "D", x: 10, y: 0, formalCharge: 0 },
        { id: "a3", element: "T", x: 0, y: 10, formalCharge: 0 }
      ],
      bonds: [
        { id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" },
        { id: "b2", fromAtomId: "a1", toAtomId: "a3", order: "single" }
      ]
    });
    const result = await nameStructure(deps({
      name: async () => verified({ tier: "abstain", limitCode: "UNSUPPORTED_ELEMENT" })
    }), drawn);

    expect(result).toMatchObject({ status: "declined", code: "unsupportedElement" });
    if (result.status === "declined") expect(result.reason).not.toContain("D");
    expect(result).toMatchObject({ reason: "The naming engine does not support this kind of structure." });
  });

  it("uses a general reason when Orthonym declines a supported carbon-free structure", async () => {
    const drawn = molecule({
      atoms: [{ id: "a1", element: "O", x: 0, y: 0, formalCharge: 0 }],
      bonds: []
    });
    await expect(nameStructure(deps({
      name: async () => verified({ tier: "abstain", limitCode: "UNSUPPORTED_ELEMENT" })
    }), drawn)).resolves.toMatchObject({
      status: "declined",
      code: "unsupportedElement",
      reason: "The naming engine does not support this kind of structure."
    });
  });

  it("keeps every decline reason free of all-caps engine codes", async () => {
    const outcomes = await Promise.all([
      nameStructure(deps({ readName: async () => ({ smiles: null, failureReason: "UNSUPPORTED_ELEMENT" }) }), molecule()),
      nameStructure(deps({ name: async () => verified({ tier: "candidate" }) }), molecule()),
      nameStructure(deps({ name: async () => verified({ tier: "abstain", limitCode: "UNSUPPORTED_ELEMENT" }) }), molecule()),
      nameStructure(deps({ name: async () => verified({ tier: "abstain", limitCode: "UNNAMEABLE" }) }), molecule()),
      nameStructure(deps({ name: async () => verified({ tier: "abstain", limitCode: "TOO_COMPLEX" }) }), molecule()),
      nameStructure(deps({ canonicalize: async () => null }), molecule()),
      nameStructure(deps({ canonicalize: async () => "C".repeat(5_001) }), molecule())
    ]);

    expect(outcomes.map((result) => result.status === "declined" && result.code)).toEqual([
      "noVerifiedName", "notFullyVerified", "unsupportedElement", "unnameable", "engineLimit", "structureNotExact", "tooLarge"
    ]);
    for (const result of outcomes) {
      expect(result.status).toBe("declined");
      if (result.status === "declined") expect(result.reason).not.toMatch(/\b(?:UNSUPPORTED_ELEMENT|UNNAMEABLE|TOO_COMPLEX)\b/);
    }
  });

  it("declines when the drawn structure cannot be canonicalized", async () => {
    await expect(nameStructure(deps({ canonicalize: async () => null }), molecule()))
      .resolves.toMatchObject({ status: "declined", code: "structureNotExact" });
  });

  it("declines dative bonds, unknown orders, and dummy atoms as not exact", async () => {
    const dative = molecule({ bonds: [{ id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single", display: { bondStyle: "dashed" } }] });
    const unknown = molecule({ bonds: [{ id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "unknown" }] });
    const dummy = molecule({
      atoms: [{ id: "a1", element: "C", x: 0, y: 0, formalCharge: 0 }, { id: "a2", element: "R", x: 10, y: 0, formalCharge: 0 }],
      bonds: [{ id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" }]
    });
    for (const drawn of [dative, unknown, dummy]) {
      await expect(nameStructure(deps(), drawn)).resolves.toMatchObject({ status: "declined", code: "structureNotExact" });
    }
  });

  // Inject at the export boundary to cover even warnings whose source path currently refuses
  // before RDKit runs. Both canonicalisations would succeed and agree; warnings must still veto.
  it.each([
    ["export.smiles_dative_bond", "Dative bond written as single."],
    ["export.smiles_bond_order", "Unknown bond order approximated."],
    ["export.smiles_atom_label", "Atom label written as dummy."],
    ["export.smiles_stereo_dropped", "Stereochemistry could not be written to SMILES."],
    ["export.smiles_v2000_loss", "Bond b1 has an unknown bond order; written as bond type 8 (any), which readers treat as a query bond with no chemical order."],
    ["export.smiles_v2000_loss", "V2000 has no coordination bond type: 1 dative (dashed) bond written as plain single. Export V3000 to preserve it."],
    ["export.smiles_v2000_loss", "Aromatic bonds at atoms a1, a2 have no resolved Kekulé order; the structure engine interpreted them for SMILES."],
    ["export.smiles_v2000_loss", "Aromatic bonds at atoms a1, a2 have no resolved Kekulé order; the structure engine interpreted them for SMILES. Hydrogen counts at literal atoms a1 could not be specified; the structure engine may add hydrogens."],
    ["export.smiles_v2000_loss", "Literal atoms a1 have an unknown-order bond; written without a valence field, so a reader may add hydrogens."],
    ["export.smiles_v2000_loss", "Literal atom \"N\" has a bond-order sum of 15, which the structure engine cannot receive exactly for SMILES; the engine may add hydrogens."],
    ["export.smiles_v2000_loss", "Atom label \"Ph\" is not an element symbol; written as a dummy atom (*) — the label's group is not represented in SMILES."],
    ["export.smiles_v2000_loss", "Atom label \"Ph\" is not an element symbol; written as R-group placeholder R1 — the label's group is not represented in SMILES."],
    ["export.smiles_v2000_loss", "Atom label \"Ar\" stands for a group here (bonded aryl); written as a dummy atom (*) — the label's group is not represented in SMILES."],
    ["export.smiles_v2000_loss", "Atom label \"NH2\" is not an element symbol; it cannot be written as N because it has an unknown-order bond, so the hydrogen count it states cannot be carried by an explicit valence; written as a dummy atom (*) — the label's group is not represented in SMILES."],
    ["export.smiles_v2000_loss", "Atom label \"NH2\" is not an element symbol; it cannot be written as N because it has an aromatic bond with no resolved Kekulé order, so the hydrogen count it states cannot be carried by an explicit valence; written as a dummy atom (*) — the label's group is not represented in SMILES."],
    ["export.smiles_v2000_loss", "Atom label \"NH2\" is not an element symbol; it cannot be written as N because its bond orders and stated hydrogens sum to 15, past the V2000 valence field's limit of 14; written as a dummy atom (*) — the label's group is not represented in SMILES."],
    ["export.future_warning", "A warning added after this policy was audited."],
    ["export.smiles_v2000_loss", "A new V2000 warning."],
    ["export.smiles_v2000_loss", "Dashed display on a double bond is not a coordination bond; written to SMILES as double, dashed style not preserved. Hydrogen counts changed."]
  ])("declines %s: %s even with a matching canonical read-back", async (code, message) => {
    const original = smilesExport.moleculeSmiles;
    vi.spyOn(smilesExport, "moleculeSmiles").mockImplementationOnce(async (...args) => {
      args[2].push({ code, message, severity: "warning" });
      return original(...args);
    });
    const services = deps();
    await expect(nameStructure(services, molecule()))
      .resolves.toMatchObject({ status: "declined", code: "structureNotExact" });
    expect(services.canonicalize).toHaveBeenCalled();
    expect(services.name).not.toHaveBeenCalled();
    expect(services.readName).not.toHaveBeenCalled();
  });

  it("declines a radical when the canonicalizer supplies no atom-state evidence", async () => {
    const drawn = molecule({
      atoms: [{ id: "a1", element: "C", x: 0, y: 0, formalCharge: 0, markRadicals: 1 }],
      bonds: [], structure: "C"
    });
    const services = deps({ canonicalize: vi.fn(async () => "[CH3]") });
    const warnings: Parameters<typeof smilesExport.moleculeSmiles>[2] = [];
    await smilesExport.moleculeSmiles(drawn, 0, warnings, async structure => ({
      smiles: (await services.canonicalize(structure)) ?? undefined
    }));
    expect(warnings).toEqual([{
      code: "export.smiles_atom_state_unverified", severity: "warning", objectId: drawn.id,
      message: "Atom states (Atom a1 (C)) could not be verified against the exported SMILES by the structure engine."
    }]);
    const result = await nameStructure(services, drawn);
    expect(result).toMatchObject({ status: "declined", code: "structureNotExact" });
    expect(result).not.toHaveProperty("name");
    expect(services.name).not.toHaveBeenCalled();
  });

  it("allows verified charge separation and still checks the name read-back", async () => {
    const original = smilesExport.moleculeSmiles;
    vi.spyOn(smilesExport, "moleculeSmiles").mockImplementationOnce(async (...args) => {
      args[2].push({
        code: "export.smiles_charge_separated", severity: "info",
        message: "SMILES writes charge-separated formal charges while preserving total charge: Atom a1 (N) is drawn with formal charge 0; SMILES reparses with formal charge 1. Atom a2 (O) is drawn with formal charge 0; SMILES reparses with formal charge -1."
      });
      return original(...args);
    });
    const services = deps();
    const result = await nameStructure(services, molecule());
    expect(result).toMatchObject({ status: "named", name: "ethanol" });
    expect(services.name).toHaveBeenCalledWith("CCO");
    expect(services.readName).toHaveBeenCalledWith("ethanol");
  });

  it("declines an unknown info-level export code", async () => {
    const original = smilesExport.moleculeSmiles;
    vi.spyOn(smilesExport, "moleculeSmiles").mockImplementationOnce(async (...args) => {
      args[2].push({ code: "export.smiles_future_note", severity: "info", message: "Future note." });
      return original(...args);
    });
    const services = deps();
    await expect(nameStructure(services, molecule()))
      .resolves.toMatchObject({ status: "declined", code: "structureNotExact" });
    expect(services.name).not.toHaveBeenCalled();
    expect(services.readName).not.toHaveBeenCalled();
  });

  it.each([false, true])("declines a real unresolved-aromatic writer warning (typed atom: %s)", async (labelLiteral) => {
    const drawn = molecule({
      atoms: molecule().atoms.slice(0, 2).map(atom => ({ ...atom, labelLiteral })),
      bonds: [{ id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "aromatic" }]
    });
    const warnings: Parameters<typeof smilesExport.moleculeSmiles>[2] = [];
    await smilesExport.moleculeSmiles(drawn, 0, warnings, async () => ({ smiles: "CCO" }));
    expect(warnings).toContainEqual(expect.objectContaining({
      code: "export.smiles_v2000_loss",
      message: expect.stringContaining(labelLiteral ? "Hydrogen counts at literal atoms" : "no resolved Kekulé order")
    }));
    const services = deps();
    await expect(nameStructure(services, drawn)).resolves.toMatchObject({ status: "declined", code: "structureNotExact" });
    expect(services.canonicalize).toHaveBeenCalled();
    expect(services.name).not.toHaveBeenCalled();
  });

  it("declines a real literal-atom valence overflow even when canonicalisation succeeds", async () => {
    const atoms = Array.from({ length: 6 }, (_, index) => ({
      id: `a${index}`, element: "N", x: index * 10, y: 0, formalCharge: 0, labelLiteral: true
    }));
    const bonds = atoms.slice(1).map(atom => ({
      id: `b${atom.id}`, fromAtomId: "a0", toAtomId: atom.id, order: "triple" as const
    }));
    const drawn = molecule({ atoms, bonds });
    const warnings: Parameters<typeof smilesExport.moleculeSmiles>[2] = [];
    await smilesExport.moleculeSmiles(drawn, 0, warnings, async () => ({ smiles: "CCO" }));
    expect(warnings).toContainEqual(expect.objectContaining({
      code: "export.smiles_v2000_loss", message: expect.stringContaining("bond-order sum of 15")
    }));
    await expect(nameStructure(deps(), drawn)).resolves.toMatchObject({ status: "declined", code: "structureNotExact" });
  });

  it.each(["double", "triple"] as const)("still names a %s bond with only a lost dashed display", async (order) => {
    const drawn = molecule({ bonds: [{
      id: "b1", fromAtomId: "a1", toAtomId: "a2", order, display: { bondStyle: "dashed" }
    }] });
    const warnings: Parameters<typeof smilesExport.moleculeSmiles>[2] = [];
    await smilesExport.moleculeSmiles(drawn, 0, warnings, async () => ({ smiles: "CCO" }));
    expect(warnings).toContainEqual(expect.objectContaining({
      code: "export.smiles_v2000_loss", message: expect.stringContaining("dashed style not preserved")
    }));
    await expect(nameStructure(deps(), drawn)).resolves.toMatchObject({ status: "named", warnings: [] });
  });

  it("still names resolved aromatic bonds with only a lost dashed display", async () => {
    const atoms = Array.from({ length: 6 }, (_, index) => ({
      id: `a${index}`, element: "C", x: Math.cos(index * Math.PI / 3) * 10,
      y: Math.sin(index * Math.PI / 3) * 10, formalCharge: 0
    }));
    const bonds = atoms.map((atom, index) => ({
      id: `b${index}`, fromAtomId: atom.id, toAtomId: atoms[(index + 1) % 6]!.id,
      order: "aromatic" as const, display: { bondStyle: "dashed" as const }
    }));
    await expect(nameStructure(deps(), molecule({ atoms, bonds })))
      .resolves.toMatchObject({ status: "named", warnings: [] });
  });

  it("enforces SMILES and heavy-atom caps", async () => {
    const tooLong = deps({ canonicalize: async () => "C".repeat(5_001) });
    await expect(nameStructure(tooLong, molecule())).resolves.toMatchObject({ status: "declined", code: "tooLarge" });

    const atoms = Array.from({ length: 501 }, (_, index) => ({ id: `a${index}`, element: "C", x: index, y: 0, formalCharge: 0 }));
    await expect(nameStructure(deps(), molecule({ atoms, bonds: [] }))).resolves.toMatchObject({ status: "declined", code: "tooLarge" });
  });
});
