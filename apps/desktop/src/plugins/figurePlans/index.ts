import { bracketPairs, DocumentObjectSchema, type ChemDraftDocument, type DocumentObject, type DocumentPage,
  type MoleculeObject } from "@chemdraft/chem-core";
import {
  changedElectronMarkAssignments, documentDrawingDefaults, isEditableNativeMoleculeGraph, listFigureStylePresets,
  moleculeTargetBondLengthChanges, nativeElectronMarkAssignments, normalizeNativeMoleculeGeometry, planFigureArrangement,
  planFigureReaction, planFigureStyle, planPageStyleUpdates, type FigureReactionStep
} from "@chemdraft/document-workflow-core";
import { resolveArrowAttachments } from "@chemdraft/layout-engine";
import { PluginRequestLimits, PluginRequestPatchSchema, requestValidationCode, type PluginRequestArguments } from "@chemdraft/plugin-api";
import { objectAnchors, preflightRequestPatch, RequestWriteError, type RequestDepictionBinding, type RequestFigurePlanProviders } from "@chemdraft/plugin-host";
import { expectedPageTranslation } from "../../documentWorkflow";
import { inspectBoundedStructure } from "../depiction/structureInspection";
import { checkPageBudget, prepareDepictionPage } from "../depiction/previewPage";
import { RESERVED_PLUGIN_OBJECT_IDS, structureFromSmilesForPlugin } from "../pluginChemistry";
import { assertRepeatUnitIdentity } from "../requestWrites/repeatUnitIdentity";
import { verifyDesktopRequestWrite } from "../requestWrites/normalizedWrite";

type LayoutSpec = PluginRequestArguments<"depiction", "planLayout">["spec"];
type ReactionSpec = Extract<LayoutSpec, { kind: "reaction" }>;
type Component = ReactionSpec["reactants"][number];

function invalid(message: string): never {
  throw new RequestWriteError("invalid", message);
}

function boundedWarnings(warnings: string[]) {
  const entries = warnings.length > 64 ? [...warnings.slice(0, 63), `And ${warnings.length - 63} more warnings.`] : warnings;
  return entries.map(message => message.slice(0, 1_000));
}

function createIdAllocator(document: ChemDraftDocument, page: DocumentPage) {
  const used = new Set([...document.pages.flatMap(candidate => candidate.objects.map(object => object.id)),
    ...page.objects.map(object => object.id)]);
  let index = 0;
  return (kind: string) => {
    let id: string;
    do { id = `figure_${kind}_${++index}`; } while (used.has(id));
    used.add(id);
    return id;
  };
}

function geometryChanges(before: DocumentObject, after: DocumentObject) {
  const changes = Object.fromEntries(Object.entries(after).filter(([key, value]) =>
    before[key as keyof DocumentObject] !== value));
  return changes as Partial<DocumentObject>;
}

function transform(before: DocumentObject, prepared: DocumentObject, dx: number, dy: number) {
  if (!dx && !dy && before === prepared) return [];
  const moved = expectedPageTranslation(prepared, dx, dy);
  validateObject(moved);
  return [{ objectId: before.id, dx, dy, changes: geometryChanges(before, moved) }];
}

function validateObject(object: DocumentObject) {
  if (!DocumentObjectSchema.safeParse(object).success) invalid(`Invalid planned geometry for "${object.id}".`);
}

function proposedPage(page: DocumentPage, updates: readonly { objectId: string; changes: Partial<DocumentObject> }[],
  additions: DocumentObject[] = []): DocumentPage {
  const changes = new Map(updates.map(update => [update.objectId, update.changes]));
  return { ...page, objects: [...page.objects.map(object => changes.has(object.id)
    ? { ...object, ...changes.get(object.id) } as DocumentObject : object), ...additions] };
}

async function verifyFigureBatch(binding: RequestDepictionBinding, page: DocumentPage,
  updates: readonly { objectId: string; changes: Partial<DocumentObject> }[], additions: DocumentObject[] = [],
  sources: readonly { objectId: string; sourceSmiles: string }[] = []) {
  if (!updates.length && !additions.length) return;
  const patch = PluginRequestPatchSchema.safeParse({ op: "batch", patches: [
    ...additions.map(object => ({ op: "addObject", pageId: page.id, object })),
    ...updates.map(({ objectId, changes }) => ({ op: "updateObject", objectId, changes }))
  ] });
  if (!patch.success) throw new RequestWriteError(requestValidationCode(patch.error), "Invalid request patch.");
  const original = binding.document.pages.find(candidate => candidate.id === page.id)!;
  const before = page === original ? binding.document : { ...binding.document,
    pages: binding.document.pages.map(candidate => candidate === original ? page : candidate) };
  // A preview may include hypothetical insertions. They are in scope on this detached draft only.
  const originalIds = new Set(original.objects.map(object => object.id));
  const selection = binding.writeSelection ?? updates.map(({ objectId }) => ({ objectId, pageId: page.id }));
  const previewAdditions = page.objects.filter(object => !originalIds.has(object.id)).map(object => ({ objectId: object.id, pageId: page.id }));
  const expected = sources.map(({ objectId, sourceSmiles }) => ({
    kind: "insertion" as const, opIndex: additions.findIndex(object => object.id === objectId), sourceSmiles
  }));
  await preflightRequestPatch(before, { patch: patch.data, reason: "Verify figure plan", warnings: [], requiresUserApproval: true },
    [...selection, ...previewAdditions], verifyDesktopRequestWrite, binding.signal, { expected });
}

function checkOperationLimit(count: number) {
  if (count > PluginRequestLimits.patches) {
    throw new RequestWriteError("limit", `The figure needs more than ${PluginRequestLimits.patches} patch operations.`);
  }
}

function anchoredObjectIds(object: DocumentObject) {
  const anchors = objectAnchors(object).flatMap(anchor => anchor.kind !== "point" && anchor.objectId ? [anchor.objectId] : []);
  return object.type === "bracket" ? [...anchors, ...object.containedObjectIds,
    ...(object.crossingBondIds ?? []).map(ref => ref.objectId)] : anchors;
}

function relationships(page: DocumentPage, assignments = nativeElectronMarkAssignments(page)) {
  // Join bracket halves before checking the rest of each half's dependencies.
  const pairRelationships = [...bracketPairs(page.objects).values()].map(([object, partner]) =>
    ({ object: object!, id: partner!.id, includePartner: true }));
  const references = page.objects.flatMap(object => {
    const refs = [
      ...anchoredObjectIds(object),
      ...(object.type === "electron-mark" ? [assignments.anchorByMarkId.get(object.id)?.objectId] : []),
      ...(object.type === "text" ? [object.arrowAttachment?.parentObjectId] : []),
      ...(object.type === "group" ? object.childObjectIds : []),
      ...(object.type === "reaction" ? [...object.components.map(component => component.objectId),
        ...(object.arrowObjectIds ?? []), ...(object.plusObjectIds ?? []), ...object.conditionsTextObjectIds] : [])
    ];
    return [...new Set(refs)].flatMap(id => id && id !== object.id ? [{ object, id, includePartner: false }] : []);
  });
  return [...pairRelationships, ...references];
}

function arrangementItems(page: DocumentPage, ids: readonly string[]) {
  const byId = new Map(page.objects.map(object => [object.id, object]));
  const owner = new Map<string, Set<DocumentObject>>();
  for (const id of ids) {
    const object = byId.get(id);
    if (!object) invalid(`Object "${id}" does not exist on page "${page.id}".`);
    owner.set(id, new Set([object]));
  }
  for (const { object, id, includePartner } of relationships(page)) {
    const a = owner.get(object.id), b = owner.get(id);
    // A selected drawable may be used in several reaction records. Their logical references
    // do not imply that the entire scheme must move with that drawable.
    if (!a && object.type === "reaction") continue;
    if (!a && !b || a === b) continue;
    if (!a || !b) {
      if (!includePartner) throw new RequestWriteError("scope",
        `Arrange "${a ? object.id : id}" together with "${a ? id : object.id}".`);
      const item = (a ?? b)!;
      const partner = a ? byId.get(id)! : object;
      item.add(partner);
      owner.set(partner.id, item);
      continue;
    }
    for (const member of b) {
      a.add(member);
      owner.set(member.id, a);
    }
  }
  return [...new Set(owner.values())].map((objects, index) => ({ id: String(index), objects: [...objects] }));
}

function arrange(page: DocumentPage, spec: Extract<LayoutSpec, { kind: "row" | "grid" }>) {
  const resolved = resolveArrowAttachments(page);
  const items = arrangementItems(resolved, spec.objectIds);
  const plan = planFigureArrangement(resolved, items, spec.kind, {
    anchor: spec.anchor, gap: spec.kind === "grid" ? spec.columnGap ?? spec.gap : spec.gap, wrapWidth: spec.wrapWidth,
    ...(spec.kind === "grid" ? { columns: spec.columns, rowGap: spec.rowGap } : {})
  });
  if (!plan.ok) invalid("The arrangement dimensions could not be planned.");
  const originals = new Map(page.objects.map(object => [object.id, object]));
  const transforms = plan.placements.flatMap(({ id, dx, dy }) => items[Number(id)]!.objects.flatMap(
    object => transform(originals.get(object.id)!, object, dx, dy)));
  const warnings = spec.wrapWidth !== undefined && plan.bounds.width > spec.wrapWidth + 1e-7
    ? ["An arrangement item exceeds the wrap width."] : [];
  return { objects: [], transforms, warnings };
}

function requireMolecule(page: DocumentPage, byId: ReadonlyMap<string, DocumentObject>, id: string) {
  const object = byId.get(id);
  if (object?.type !== "molecule" || !isEditableNativeMoleculeGraph(object)) {
    invalid(`Editable molecule "${id}" was not found on page "${page.id}".`);
  }
  return object;
}

async function reaction(
  document: ChemDraftDocument, page: DocumentPage, original: ChemDraftDocument,
  spec: Extract<LayoutSpec, { kind: "reaction" | "reactionRows" }>,
  signal: AbortSignal, build: typeof structureFromSmilesForPlugin
) {
  const steps = spec.kind === "reaction" ? [spec] : spec.steps;
  const components = steps.flatMap(step => [...step.reactants, ...step.products]);
  const byId = new Map(page.objects.map(object => [object.id, object]));
  const pinned = new Map(components.flatMap(component => typeof component === "string"
    ? [[component, requireMolecule(page, byId, component)] as const] : []));
  const sources = new Map<string, string>();
  for (const component of components) {
    if (typeof component === "string" || !("smiles" in component) || typeof component.smiles !== "string") continue;
    const previous = sources.get(component.ref);
    if (previous !== undefined && previous !== component.smiles) invalid(`Conflicting SMILES for reference "${component.ref}".`);
    sources.set(component.ref, component.smiles);
  }
  if (pinned.size + sources.size > PluginRequestLimits.readObjects) {
    throw new RequestWriteError("limit", `A reaction figure supports up to ${PluginRequestLimits.readObjects} compounds.`);
  }
  const checkRef = (component: Component) => {
    if (typeof component !== "string" && !sources.has(component.ref)) invalid(`Unknown structure reference "${component.ref}".`);
  };
  components.forEach(checkRef);
  for (const step of steps) for (const id of step.agents ?? []) requireMolecule(page, byId, id);
  if (spec.kind === "reactionRows" && spec.breakBefore?.some(index => index >= steps.length)) {
    invalid("A requested row break is outside the step list.");
  }
  const defaults = documentDrawingDefaults(document);
  const bondLength = spec.bondLength ?? defaults.bondLengthPx;
  const nextId = createIdAllocator(original, page);
  const insertionSources = [...sources].map(([ref, sourceSmiles]) => ({ ref, sourceSmiles, objectId: nextId("molecule") }));
  const refIds = new Map(insertionSources.map(source => [source.ref, source.objectId]));
  const compoundNumbers = new Map<string, string>();
  for (const { component, text } of steps.flatMap(step => step.compoundNumbers ?? [])) {
    checkRef(component);
    const id = typeof component === "string" ? component : refIds.get(component.ref)!;
    if (typeof component === "string" && !pinned.has(component)) invalid(`Compound "${component}" is outside the reaction figure.`);
    const previous = compoundNumbers.get(id);
    if (previous !== undefined && previous !== text) invalid(`Conflicting compound numbers for "${id}".`);
    compoundNumbers.set(id, text);
  }

  const assignments = nativeElectronMarkAssignments(page);
  const carriedMarks = new Map(page.objects.flatMap(object => {
    if (object.type !== "electron-mark") return [];
    const anchor = assignments.anchorByMarkId.get(object.id);
    return anchor && pinned.has(anchor.objectId) ? [[object.id, anchor] as const] : [];
  }));
  for (const object of page.objects) {
    if (carriedMarks.has(object.id)) continue;
    const id = anchoredObjectIds(object).find(id => id !== object.id && pinned.has(id));
    if (id) throw new RequestWriteError("scope",
      `Cannot place "${id}" with dependent ${object.type} "${object.id}" in a reaction figure.`);
  }
  const styleWarnings: Parameters<typeof planPageStyleUpdates>[4] = [];
  const updates = spec.bondLength === undefined ? [] :
    planPageStyleUpdates(page, new Set(pinned.keys()), undefined, bondLength, styleWarnings);
  const refusal = styleWarnings.find(warning => warning.code === "style_preset.chemistry_change_refused");
  if (refusal) throw new RequestWriteError("chemistry", refusal.message);
  const styled = new Map(updates.map(update => [update.objectId, update.changes]));
  const built = new Map<string, MoleculeObject>();
  let atoms = 0, bonds = 0;
  for (const sourceSmiles of new Set(sources.values())) {
    await inspectBoundedStructure({ format: "smiles", structure: sourceSmiles }, signal, "graphSize");
  }
  for (const { objectId, sourceSmiles, ref } of insertionSources) {
    signal.throwIfAborted();
    const result = await build({ smiles: sourceSmiles }, () => document, signal);
    if (result.available && result.built) RESERVED_PLUGIN_OBJECT_IDS.delete(result.object.id);
    signal.throwIfAborted();
    if (!result.available) throw new RequestWriteError("unavailable", result.reason);
    if (!result.built) throw new RequestWriteError("chemistry", `Structure "${ref}": ${result.reason}`);
    const object = result.object;
    if (object.type !== "molecule" || !isEditableNativeMoleculeGraph(object)) invalid(`Structure "${ref}" is not an editable molecule.`);
    atoms += object.atoms.length;
    bonds += object.bonds.length;
    if (atoms > PluginRequestLimits.atomsPerMolecule || bonds > PluginRequestLimits.bondsPerMolecule ||
        object.atoms.filter(atom => atom.element !== "H" && atom.element !== "D" && atom.element !== "T").length > PluginRequestLimits.heavyAtoms) {
      throw new RequestWriteError("limit", `Structure "${ref}" exceeds the reaction figure's graph limits.`);
    }
    built.set(ref, { ...object, ...moleculeTargetBondLengthChanges(object, bondLength), id: objectId });
  }
  const prepared = new Map([...pinned].map(([id, object]) => [id,
    styled.has(id) ? { ...object, ...styled.get(id) } as MoleculeObject : object]));
  const resolve = (component: Component) => typeof component === "string" ? prepared.get(component)! : built.get(component.ref)!;
  const plannedSteps: FigureReactionStep[] = steps.map(step => ({
    ...step, reactants: step.reactants.map(resolve), products: step.products.map(resolve), agentIds: step.agents
  }));
  const plan = planFigureReaction(plannedSteps, { anchor: spec.anchor, bondLength, textStyle: defaults.textStyle,
    nextId, compoundNumbers, newMoleculeIds: new Set(refIds.values()), ...(spec.kind === "reactionRows" ? {
      rows: { maxWidth: spec.maxWidth, gap: spec.gap ?? bondLength, breakBefore: spec.breakBefore }
    } : {}) });
  const objects: DocumentObject[] = [
    ...insertionSources.map(({ objectId, ref }) => {
      const original = built.get(ref)!;
      const placed = plan.placements.get(objectId)!;
      const translated = expectedPageTranslation(original, placed.x - original.x, placed.y - original.y) as MoleculeObject;
      return normalizeNativeMoleculeGeometry({ ...translated, atoms: placed.atoms, bonds: placed.bonds });
    }),
    ...plan.objects
  ];
  const transforms = [...prepared].flatMap(([id, object]) => {
    const placed = plan.placements.get(id)!;
    return transform(pinned.get(id)!, object, placed.x - object.x, placed.y - object.y);
  });
  for (const [id, anchor] of carriedMarks) {
    const mark = byId.get(id)!;
    const moved = transforms.find(item => item.objectId === anchor.objectId);
    if (!moved) continue;
    const carry = { ...mark, ...styled.get(id), anchor: { kind: "atom" as const, ...anchor } } as DocumentObject;
    transforms.push(...transform(mark, carry, moved.dx, moved.dy));
  }
  objects.forEach(validateObject);
  checkOperationLimit(objects.length + transforms.length);
  return {
    objects, transforms, insertionSources,
    warnings: [...styleWarnings.map(warning => warning.message), ...plan.warnings,
      ...[...carriedMarks.keys()].filter(id => transforms.some(item => item.objectId === id))
        .map(id => `The proposed move includes dependent electron mark "${id}".`)]
  };
}

export function createFigurePlanProviders(build = structureFromSmilesForPlugin): RequestFigurePlanProviders {
  return {
    listStylePresets(_input, binding) {
      binding.signal.throwIfAborted();
      return { ok: true, value: listFigureStylePresets(binding.document) };
    },
    async planStyle(input, binding) {
      binding.signal.throwIfAborted();
      const { page } = prepareDepictionPage(binding.document, input.pageId, input.preview);
      const plan = planFigureStyle(page, input);
      const byId = new Map(page.objects.map(object => [object.id, object]));
      const geometry = new Set(plan.updates.filter(update => "atoms" in update.changes).map(update => update.objectId));
      const changed = new Set(plan.affectedObjectIds);
      const missing = page.objects.flatMap(object => changed.has(object.id) ? [] :
        objectAnchors(object).filter(anchor => anchor.objectId && geometry.has(anchor.objectId))
          .map(anchor => `Cannot rescale "${anchor.objectId}" with dependent ${object.type} "${object.id}".`));
      if (missing.length) return { ok: true, value: {
        updates: [], affectedObjectIds: [], movedMarkIds: [], warnings: boundedWarnings([...plan.warnings, ...missing])
      } };
      for (const update of plan.updates) validateObject({ ...byId.get(update.objectId), ...update.changes } as DocumentObject);
      checkOperationLimit(plan.updates.length);
      await verifyFigureBatch(binding, page, plan.updates);
      binding.check();
      return { ok: true, value: { ...plan, warnings: boundedWarnings(plan.warnings) } };
    },
    async planLayout(input, binding) {
      binding.signal.throwIfAborted();
      const { document, page } = prepareDepictionPage(binding.document, input.pageId, input.preview);
      const { spec } = input;
      const plan = spec.kind === "grid" || spec.kind === "row" ? arrange(page, spec)
        : await reaction(document, page, binding.document, spec, binding.signal, build);
      const proposed = proposedPage(page, plan.transforms, plan.objects);
      checkPageBudget(proposed);
      assertRepeatUnitIdentity(page, proposed);
      const [association] = changedElectronMarkAssignments(page, proposed);
      if (association) throw new RequestWriteError("chemistry",
        `The layout would change the atom associated with electron mark "${association.markId}".`);
      await verifyFigureBatch(binding, page, plan.transforms, plan.objects, "insertionSources" in plan ? plan.insertionSources : []);
      binding.check();
      return { ok: true, value: { ...plan, warnings: boundedWarnings(plan.warnings) } };
    }
  };
}
