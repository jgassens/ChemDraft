import { test, expect } from "vitest";
import { scaleDocumentObjectsAroundPoint, createPhase4Document, insertNativeSingleBondMolecule } from "./documentWorkflow";

test("resize segments", () => {
  const doc1 = insertNativeSingleBondMolecule(createPhase4Document("Test"), { x: 100, y: 100 });
  const doc2 = insertNativeSingleBondMolecule(doc1, { x: 300, y: 300 });

  const scaled = scaleDocumentObjectsAroundPoint(doc2, [doc2.pages[0].objects[0].id, doc2.pages[0].objects[1].id], {x: 200, y: 200}, 2, 2);

  const origMol = doc2.pages[0].objects[0] as any;
  const scaledMol = scaled.pages[0].objects[0] as any;

  console.log("Orig SVG rawX:", origMol.atoms[0].x - origMol.x, origMol.atoms[1].x - origMol.x);
  console.log("Scaled SVG rawX:", scaledMol.atoms[0].x - scaledMol.x, scaledMol.atoms[1].x - scaledMol.x);
  console.log("Orig molecule width:", origMol.width);
  console.log("Scaled molecule width:", scaledMol.width);
});
