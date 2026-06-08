// @vitest-environment jsdom
//
// These tests exercise the DOM-hint tiebreaker, which only engages when a real `Element`
// is under the pointer (the rest of the hit-test is pure geometry, covered in
// hitTest.test.ts in the node environment). This is the "hovering produced inconsistent
// highlighting" regression: a DOM hint must never override a geometrically-closer pick.

import { describe, it, expect } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";

import { createPhase4Document, insertNativeSingleBondMolecule } from "../documentWorkflow";
import { hitTestDocument } from "./hitTest";

function singleBondMolecule() {
  const doc = insertNativeSingleBondMolecule(createPhase4Document("hit-test-dom"), { x: 200, y: 220 });
  const molecule = doc.pages[0].objects[0];
  if (molecule.type !== "molecule") {
    throw new Error("expected a molecule fixture");
  }
  return { doc, molecule: molecule as MoleculeObject };
}

/** A stand-in for the SVG node the browser reports as `event.target`. */
function atomHitElement(atomId: string): Element {
  const element = document.createElement("div");
  element.setAttribute("data-hit-target", "atom");
  element.setAttribute("data-atom-id", atomId);
  return element;
}

/** A stand-in for the bond SVG node the browser reports as `event.target`. */
function bondHitElement(bondId: string, objectId: string): Element {
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-object-id", objectId);
  const hit = document.createElement("div");
  hit.setAttribute("data-hit-target", "bond");
  hit.setAttribute("data-bond-id", bondId);
  wrapper.appendChild(hit);
  return hit;
}

/** Same hit node, but wrapped in the molecule wrapper that owns it (carries data-object-id). */
function ownedAtomHitElement(atomId: string, objectId: string): Element {
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-object-id", objectId);
  const hit = atomHitElement(atomId);
  wrapper.appendChild(hit);
  return hit;
}

describe("hitTestDocument DOM-hint tiebreaker", () => {
  it("corroborates the geometric pick when the DOM agrees", () => {
    const { doc, molecule } = singleBondMolecule();
    const a0 = molecule.atoms[0];

    const hit = hitTestDocument(doc, { x: a0.x, y: a0.y }, atomHitElement(a0.id));
    expect(hit).toMatchObject({ kind: "atom", atomId: a0.id });
  });

  it("does NOT let a stale/far DOM hint override a clear geometric winner", () => {
    const { doc, molecule } = singleBondMolecule();
    const [a0, a1] = molecule.atoms;

    // Pointer sits exactly on a0, but the event target is a1's element (as if the SVG
    // node under the cursor were stale or re-stacked). Geometry must still win.
    const hit = hitTestDocument(doc, { x: a0.x, y: a0.y }, atomHitElement(a1.id));
    expect(hit).toMatchObject({ kind: "atom", atomId: a0.id });
  });

  it("rescues a near-miss: pointer over the glyph but just outside the center hit radius", () => {
    const { doc, molecule } = singleBondMolecule();
    const a0 = molecule.atoms[0];
    const justOutside = { x: a0.x, y: a0.y + 9 }; // 9px > 8px atom radius, off the bond

    // With no DOM target geometry finds nothing here...
    expect(hitTestDocument(doc, justOutside)).toBeUndefined();
    // ...but the pointer is literally over a0's rendered element, so the DOM hint adopts it,
    // tagged with its provenance so it is distinguishable from a pure geometric pick.
    expect(hitTestDocument(doc, justOutside, atomHitElement(a0.id))).toMatchObject({
      kind: "atom",
      atomId: a0.id,
      source: "atom-dom-tiebreak"
    });
  });

  it("ignores a hint whose owning molecule is not the one under the pointer", () => {
    // Molecule-local ids repeat across molecules, so the page-wide loop must not let a hint
    // owned by molecule A promote the same-id atom inside molecule B. A hint tagged with a
    // foreign owner is rejected, so the near-miss is NOT rescued here.
    const { doc, molecule } = singleBondMolecule();
    const a0 = molecule.atoms[0];
    const justOutside = { x: a0.x, y: a0.y + 9 };

    // Same atom id, but owned by a different molecule than the one being scored.
    expect(hitTestDocument(doc, justOutside, ownedAtomHitElement(a0.id, "mol_other"))).toBeUndefined();
    // Owned by the correct molecule, the hint still works (control).
    expect(hitTestDocument(doc, justOutside, ownedAtomHitElement(a0.id, molecule.id))).toMatchObject({
      kind: "atom",
      atomId: a0.id
    });
  });
});

// Invariant #5 (docs/architecture/pointer-picking-hardening.md): bonds are ALWAYS
// model-derived. A bond DOM target may route the event to the molecule, but it must never
// manufacture or shift bond identity — the geometric model hit is the sole authority for
// bonds. Pinned now so the step-5 provenance work cannot reintroduce a bond DOM fallback.
describe("hitTestDocument bonds are never DOM-derived (invariant #5)", () => {
  it("ignores a bond DOM hint where the model finds no bond (no manufactured hit)", () => {
    const { doc, molecule } = singleBondMolecule();
    const bondId = molecule.bonds[0].id;
    // A point well clear of every atom and bond: the model rejects it outright.
    const empty = { x: 24, y: 24 };

    expect(hitTestDocument(doc, empty)).toBeUndefined();
    // Even with the browser reporting the bond's hit node as the event target, the result
    // stays undefined — the DOM cannot fabricate a bond hit the model did not find.
    expect(hitTestDocument(doc, empty, bondHitElement(bondId, molecule.id))).toBeUndefined();
  });

  it("does not let a bond DOM hint change which part the model picked", () => {
    const { doc, molecule } = singleBondMolecule();
    const a0 = molecule.atoms[0];
    const bondId = molecule.bonds[0].id;

    // Pointer sits exactly on a0 (a clear atom winner). A bond DOM target must not flip it.
    const withoutHint = hitTestDocument(doc, { x: a0.x, y: a0.y });
    const withBondHint = hitTestDocument(doc, { x: a0.x, y: a0.y }, bondHitElement(bondId, molecule.id));
    expect(withBondHint).toEqual(withoutHint);
    expect(withBondHint).toMatchObject({ kind: "atom", atomId: a0.id });
  });
});
