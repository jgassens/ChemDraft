import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import pyridinium from "./fixtures/pyridinium.json";
import blueBox from "./fixtures/blue-box.json";
import oxathiazinane from "./fixtures/oxathiazinane.json";
import toluene from "./fixtures/toluene.json";
import { nativeMoleculeRings } from "./index";

// Real `document --smiles` outputs; coordinates and chemistry are never reconstructed in tests.
export const ringHaloDocuments = { pyridinium, "blue-box": blueBox, oxathiazinane, toluene };
export const ringHaloStyles = {
  light: { colors: ["#1e88e5"], opacity: 0.25 },
  solid: { colors: ["#1e88e5"], opacity: 1 },
  vivid: { colors: ["#e53935", "#fdd835", "#1e88e5", "#43a047"], opacity: 0.9 }
};
export function ringHaloDocument(name: keyof typeof ringHaloDocuments, style: keyof typeof ringHaloStyles) {
  const document = structuredClone(ringHaloDocuments[name]) as ChemDraftDocument;
  const object = document.pages[0]!.objects[0] as MoleculeObject;
  const { colors, opacity } = ringHaloStyles[style];
  object.style.ringStyles = Object.fromEntries(nativeMoleculeRings(object).map((ring, index) => [
    ring.ringKey, { fillColor: colors[index % colors.length]!, fillOpacity: opacity }
  ]));
  return { document, object };
}
