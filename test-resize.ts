import { test } from "vitest";
import { scaleDocumentObjectsAroundPoint } from "./apps/desktop/src/documentWorkflow.ts";
import { createPhase4Document, insertNativeSingleBondMolecule } from "./apps/desktop/src/documentFixtures.ts";
import { selectedMolecule } from "./apps/desktop/src/testWorkflow.ts";
import { bondLineSegments } from "./apps/desktop/src/rendering.ts";

const doc1 = insertNativeSingleBondMolecule(createPhase4Document("Test"), { x: 100, y: 100 });
// Insert a second one
const doc2 = insertNativeSingleBondMolecule(doc1, { x: 300, y: 300 });

// Now scale them both around (200, 200) by 2x
const scaled = scaleDocumentObjectsAroundPoint(doc2, [doc2.pages[0].objects[0].id, doc2.pages[0].objects[1].id], {x: 200, y: 200}, 2, 2);

console.log("Original Mol 1:");
console.log(doc2.pages[0].objects[0]);

console.log("\nScaled Mol 1:");
console.log(scaled.pages[0].objects[0]);

const origMol = doc2.pages[0].objects[0] as any;
const scaledMol = scaled.pages[0].objects[0] as any;
const origSegments = bondLineSegments(origMol.atoms[0], origMol.atoms[1], origMol, origMol.bonds[0], { multipleBondGapPx: 4, labelClearancePx: 2 } as any, undefined, undefined);
const scaledSegments = bondLineSegments(scaledMol.atoms[0], scaledMol.atoms[1], scaledMol, scaledMol.bonds[0], { multipleBondGapPx: 4, labelClearancePx: 2 } as any, undefined, undefined);

console.log("\nOrig Segments:", origSegments);
console.log("Scaled Segments:", scaledSegments);

