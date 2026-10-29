import {
  nativeDrawingStyleFromObjectStyle,
  type ChemDraftDocument,
  type MoleculeObject
} from "@chemdraft/chem-core";
import { structureTemplates, type StructureTemplate } from "@chemdraft/template-library";
import { createSmilesMolecule } from "./molecule";
import { documentDrawingDefaults } from "./drawingDefaults";
import type { PagePoint } from "./shared";
import type { StructureNameDeps } from "./structureName";

/**
 * NFKC, lowercase, then spell out α/ɑ, β, γ, δ (including Greek capitals after folding).
 * Remove whitespace, Unicode Dash characters, ()[]{}, commas, straight/curly/modifier
 * apostrophes and prime marks. Keep every digit in order, periods and all other characters.
 * This is an exact spelling key, never a fuzzy or chemistry-dependent match.
 */
export function normalizeStructureTemplateName(text: string): string {
  const greek: Record<string, string> = { α: "alpha", ɑ: "alpha", β: "beta", γ: "gamma", δ: "delta" };
  return text.normalize("NFKC").toLowerCase()
    .replace(/[αɑβγδ]/gu, (letter) => greek[letter]!)
    .replace(/[\s\p{White_Space}\p{Dash}()[\]{},'\u2018-\u201B\u02B9-\u02BC\u2032-\u2037]/gu, "");
}

const templatesByName = new Map(structureTemplates.flatMap((template) =>
  [template.name, ...template.synonyms].map((name) => [normalizeStructureTemplateName(name), template] as const)
));

export function resolveStructureTemplateName(text: string): StructureTemplate | undefined {
  return templatesByName.get(normalizeStructureTemplateName(text));
}

type Canonicalize = StructureNameDeps["canonicalize"];
const canonicalTemplates = new WeakMap<Canonicalize, Map<number, Promise<ReadonlyMap<string, StructureTemplate>>>>();

/** Exact canonical isomeric identity only: no stereo removal, neutralization or desalting. */
export async function structureTemplateForSmiles(
  smiles: string,
  canonicalize: Canonicalize
): Promise<StructureTemplate | undefined> {
  const input = await canonicalize(smiles);
  if (input === null) return undefined;
  // Count tokens in the engine's canonical SMILES (ordinary H is implicit by contract).
  // This is only a cheap rejection filter, never an identity/valence/stereo decision.
  // Small ordinary molecules and unrelated macrocycles must not canonicalize the entire
  // catalog, including the much larger hosts, before reaching their normal depiction path.
  const atomCount = input.match(/\[[^\]]*\]|Br|Cl|[A-Za-z*]/g)?.length ?? 0;
  const candidates = structureTemplates.filter(template => template.layout.atoms.length === atomCount);
  if (!candidates.length) return undefined;
  let bySize = canonicalTemplates.get(canonicalize);
  if (!bySize) {
    bySize = new Map();
    canonicalTemplates.set(canonicalize, bySize);
  }
  let entries = bySize.get(atomCount);
  if (!entries) {
    entries = Promise.all(candidates.map(async (template) =>
      [await canonicalize(template.smiles), template] as const
    )).then((pairs) => new Map(pairs.flatMap(([key, template]) => key === null ? [] : [[key, template] as const])));
    bySize.set(atomCount, entries);
    // A transient engine failure must not poison this caller's cache permanently.
    const cache = bySize;
    void entries.catch(() => cache.delete(atomCount));
  }
  return (await entries).get(input);
}

export interface StructureTemplateMoleculeOptions {
  document: ChemDraftDocument;
  centre: PagePoint;
  /** Overrides the document's drawing style, including its target bond length. */
  style?: Record<string, unknown>;
  reservedObjectIds?: Set<string>;
}

/** Retain the authored layout, with its mean bond length scaled exactly and its y axis flipped. */
export function structureTemplateMolecule(
  template: StructureTemplate,
  options: StructureTemplateMoleculeOptions
): MoleculeObject {
  const { document, centre, reservedObjectIds } = options;
  if (!Number.isFinite(centre.x) || !Number.isFinite(centre.y)) {
    throw new Error("Cannot place a structure template: centre must be finite.");
  }
  const defaults = documentDrawingDefaults(document);
  const style = { ...defaults.objectStyle, ...options.style };
  const bondLengthPx = options.style
    ? nativeDrawingStyleFromObjectStyle(style).bondLengthPx : defaults.bondLengthPx;
  return createSmilesMolecule(document, centre, {
    atoms: template.layout.atoms.map((atom) => ({ ...atom, charge: atom.charge ?? 0 })),
    bonds: template.layout.bonds.map(([from, to, order, display]) => ({
      from, to, order: order === 1 ? "single" : order === 2 ? "double" : "triple",
      wedge: display === "hash" ? "hashed" : display ?? null
    }))
  }, template.smiles, {
    objectIdPrefix: "mol_template",
    styleSource: `structure-template:${template.id}`,
    warningCode: "template.original_layout",
    warningMessage: `Inserted ${template.name} using its original ChemDraft layout.${template.note ? ` ${template.note}` : ""}`,
    reservedObjectIds
  }, {
    bondLengthPx,
    objectStyle: style,
    constrainToPage: false
  });
}

/** Status for a host-built template object; no identity or coordinate inference. */
export function structureTemplateLayoutMessage(molecule: MoleculeObject): string | undefined {
  const template = structureTemplates.find(entry => molecule.style.source === `structure-template:${entry.id}`);
  return template ? `Used the ${template.name} template layout` : undefined;
}
