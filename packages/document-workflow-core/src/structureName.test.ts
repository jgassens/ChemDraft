// This test stays beside its module so the policy contract is easy to audit. The purity boundary
// scans src imports as production dependencies, so use the workspace test runner by its local path.
import { describe, expect, it, vi } from "../../../node_modules/vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";

import {
  acceptOrthonymResult,
  nameStructure,
  verifyNameRoundTrip,
  type OrthonymRawResult,
  type StructureNameDeps
} from "./structureName";

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

  it("enforces SMILES and heavy-atom caps", async () => {
    const tooLong = deps({ canonicalize: async () => "C".repeat(5_001) });
    await expect(nameStructure(tooLong, molecule())).resolves.toMatchObject({ status: "declined", code: "tooLarge" });

    const atoms = Array.from({ length: 501 }, (_, index) => ({ id: `a${index}`, element: "C", x: index, y: 0, formalCharge: 0 }));
    await expect(nameStructure(deps(), molecule({ atoms, bonds: [] }))).resolves.toMatchObject({ status: "declined", code: "tooLarge" });
  });
});
