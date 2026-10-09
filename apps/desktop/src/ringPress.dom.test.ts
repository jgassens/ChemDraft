// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  applyNativeTemplatePlacementPlan,
  createPhase4Document,
  insertNativeTemplateMolecule,
  planNativeTemplatePlacement
} from "./documentWorkflow";
import { nativeMoleculeRings } from "@chemdraft/layout-engine";
import { nativeBondLengthPx, tryNativeSingleBondGraphSmiles } from "@chemdraft/document-workflow-core";
import { nativeMoleculeRingSelectionFromPointerTarget, nativeTemplateStatusForApplication } from "./MainWindow";
import { applyPatches, type MoleculeObject } from "@chemdraft/chem-core";

/**
 * Coverage for the ring-press path the app actually runs.
 *
 * `resolveSelectionHit` in `interaction/hitTest.ts` is tested but never called; the shipped press
 * goes through `nativeMoleculeRingSelectionFromPointerTarget`, whose FIRST branch reads the ring
 * key off the pressed SVG node. Only its geometric fallback had a test, so the branch that decides
 * nearly every real ring press was unguarded — which is what made the hitTest suite read like
 * coverage it was not providing.
 */
describe("ring press (the shipped path)", () => {
  function benzene(): MoleculeObject {
    const document = insertNativeTemplateMolecule(
      createPhase4Document("Ring Press"),
      { x: 300, y: 300 },
      "benzene"
    );
    const molecule = document.pages[0].objects[0];
    if (molecule.type !== "molecule") {
      throw new Error("Expected the benzene fixture to be a molecule.");
    }
    return molecule;
  }

  /** An SVG-ish node carrying the ring key, like the rendered ring hit target does. */
  function ringHitNode(ringKey: string): Element {
    const node = window.document.createElement("div");
    node.setAttribute("data-ring-hit-key", ringKey);
    const child = window.document.createElement("span");
    node.append(child);
    window.document.body.append(node);
    return child;
  }

  it("takes the ring key from the pressed node, even when the point is outside the ring", () => {
    const molecule = benzene();
    const ring = nativeMoleculeRings(molecule)[0];
    if (!ring) {
      throw new Error("Expected a benzene ring.");
    }

    // Press far outside the molecule, but on a node that carries the ring key. The key must win —
    // that is the whole point of the branch, and geometry alone would return nothing here.
    const farAway = { x: molecule.x + molecule.width + 200, y: molecule.y + molecule.height + 200 };
    const hit = nativeMoleculeRingSelectionFromPointerTarget(molecule, ringHitNode(ring.ringKey), farAway);

    expect(hit).toEqual({
      objectId: molecule.id,
      kind: "ring",
      ringKey: ring.ringKey,
      atomIds: ring.atomIds,
      bondIds: ring.bondIds
    });
  });

  it("resolves the key from an ancestor, since the press lands on a child node", () => {
    const molecule = benzene();
    const ring = nativeMoleculeRings(molecule)[0]!;
    // ringHitNode returns the CHILD; the key lives on its parent, reached via closest().
    const hit = nativeMoleculeRingSelectionFromPointerTarget(molecule, ringHitNode(ring.ringKey), ring.center);
    expect(hit?.ringKey).toBe(ring.ringKey);
  });

  it("falls back to geometry when the pressed node carries no key", () => {
    const molecule = benzene();
    const ring = nativeMoleculeRings(molecule)[0]!;
    const bare = window.document.createElement("div");

    expect(nativeMoleculeRingSelectionFromPointerTarget(molecule, bare, ring.center)?.ringKey)
      .toBe(ring.ringKey);
    // And with no node at all — the path a synthetic or forwarded event takes.
    expect(nativeMoleculeRingSelectionFromPointerTarget(molecule, null, ring.center)?.ringKey)
      .toBe(ring.ringKey);
  });

  it("falls back to geometry when the node's key names a ring this molecule does not have", () => {
    // A stale key from a previous render must not select nothing; the geometric pick still applies.
    const molecule = benzene();
    const ring = nativeMoleculeRings(molecule)[0]!;
    const stale = ringHitNode("ring:not-in-this-molecule");

    expect(nativeMoleculeRingSelectionFromPointerTarget(molecule, stale, ring.center)?.ringKey)
      .toBe(ring.ringKey);
  });

  it("selects nothing when neither the node nor the geometry finds a ring", () => {
    const molecule = benzene();
    const outside = { x: molecule.x + molecule.width + 200, y: molecule.y + molecule.height + 200 };

    expect(nativeMoleculeRingSelectionFromPointerTarget(molecule, null, outside)).toBeUndefined();
  });

  it("places exactly one separate ring when a full-valence atom cannot accept the template", () => {
    const seed = insertNativeTemplateMolecule(createPhase4Document("Ring fallback"), { x: 320, y: 320 }, "cyclohexane");
    const original = seed.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule");
    if (!original) throw new Error("Expected original molecule.");
    const atom = original.atoms[0];
    if (!atom) throw new Error("Expected ring atom.");
    // Four single bonds make this carbon unable to accept the two new spiro bonds.
    const saturated: MoleculeObject = {
      ...original,
      atoms: [
        ...original.atoms,
        { id: "atom_extra_1", element: "C", x: atom.x + 30, y: atom.y, formalCharge: 0 },
        { id: "atom_extra_2", element: "C", x: atom.x - 30, y: atom.y, formalCharge: 0 }
      ],
      bonds: [
        ...original.bonds,
        { id: "bond_extra_1", fromAtomId: atom.id, toAtomId: "atom_extra_1", order: "single" },
        { id: "bond_extra_2", fromAtomId: atom.id, toAtomId: "atom_extra_2", order: "single" }
      ]
    };
    const document = applyPatches(seed, [{ op: "updateObject", objectId: original.id, changes: saturated }]);
    const before = document.pages[0].objects.find((object): object is MoleculeObject => object.id === original.id);
    if (!before) throw new Error("Expected saturated molecule.");

    const plan = planNativeTemplatePlacement(document, {
      point: { x: atom.x, y: atom.y },
      target: { objectId: before.id, kind: "atom", atomId: atom.id, distanceToPointer: 0 }
    }, "benzene");
    expect(plan).toMatchObject({ kind: "standalone", fallbackReason: "atom-no-free-valence" });
    expect(nativeTemplateStatusForApplication("benzene", {
      objectId: before.id,
      kind: "atom",
      atomId: atom.id,
      distanceToPointer: 0
    }, true, plan?.fallbackReason)).toBe("Placed benzene separately: that atom has no free valence");
    const placed = applyNativeTemplatePlacementPlan(document, plan!);
    const unchanged = placed.pages[0].objects.find((object): object is MoleculeObject => object.id === before.id);
    const ring = placed.pages[0].objects.find((object): object is MoleculeObject => object.id === plan!.molecule.id);

    expect(tryNativeSingleBondGraphSmiles(unchanged?.atoms ?? [], unchanged?.bonds ?? [])).toEqual(
      tryNativeSingleBondGraphSmiles(before.atoms, before.bonds)
    );
    expect(unchanged?.atoms).toHaveLength(before.atoms.length);
    expect(unchanged?.bonds).toHaveLength(before.bonds.length);
    expect(placed.pages[0].objects.filter((object) => object.type === "molecule")).toHaveLength(2);
    expect(placed.selection.objectIds).toEqual([plan!.molecule.id]);
    expect(ring?.atoms.every((ringAtom) => before.atoms.every((existingAtom) =>
      Math.hypot(ringAtom.x - existingAtom.x, ringAtom.y - existingAtom.y) >= nativeBondLengthPx
    ))).toBe(true);
  });
});
