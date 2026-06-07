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
    // ...but the pointer is literally over a0's rendered element, so the DOM hint adopts it.
    expect(hitTestDocument(doc, justOutside, atomHitElement(a0.id))).toMatchObject({
      kind: "atom",
      atomId: a0.id
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
