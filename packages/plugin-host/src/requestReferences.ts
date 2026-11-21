import { checkChangedObjectReferences } from "@chemdraft/chem-core";
import type { Anchor, ApplyPatchOptions, ChemDraftDocument, DocumentObject, DocumentPatch } from "@chemdraft/chem-core";
import { RequestWriteError } from "./requestWrites";

/** All AnchorSchema fields in chem-core, including molecule attachment metadata. */
export function objectAnchors(object: DocumentObject): readonly Anchor[] {
  switch (object.type) {
    case "electron-mark": return [object.anchor];
    case "mechanism-arrow": return [object.source, object.target];
    case "reaction-arrow": return [object.start, object.end];
    case "superatom": return object.metadata.attachmentPoints;
    case "r-group-label": return object.display.attachmentPoints;
    case "molecule": return [...object.superatoms, ...object.rGroups].flatMap(item => item.attachmentPoints);
    default: return [];
  }
}

function missingReferences(object: DocumentObject, objects: ReadonlyMap<string, DocumentObject>): string[] {
  const missing: string[] = [];
  const check = (id: string, type?: DocumentObject["type"]) => {
    const target = objects.get(id);
    if (!target || (type && target.type !== type)) missing.push(id);
  };
  for (const anchor of objectAnchors(object)) {
    if (anchor.kind === "point") continue;
    const target = anchor.objectId && objects.get(anchor.objectId);
    if (!target || (anchor.kind === "atom" &&
      (target.type !== "molecule" || !target.atoms.some(atom => atom.id === anchor.atomId))) ||
      (anchor.kind === "bond" && (target.type !== "molecule" || !target.bonds.some(bond => bond.id === anchor.bondId)))) {
      missing.push(anchor.objectId ?? anchor.kind);
    }
  }
  switch (object.type) {
    case "reaction":
      object.components.forEach(component => check(component.objectId, "molecule"));
      object.conditionsTextObjectIds.forEach(id => check(id, "text"));
      object.arrowObjectIds?.forEach(id => check(id)); // Ordinary arrows may use the native graphic type.
      object.plusObjectIds?.forEach(id => check(id));
      break;
    case "bracket":
      object.containedObjectIds.forEach(id => check(id));
      for (const ref of object.crossingBondIds ?? []) {
        const target = objects.get(ref.objectId);
        if (target?.type !== "molecule" || !target.bonds.some(bond => bond.id === ref.bondId)) missing.push(ref.objectId);
      }
      break;
    case "reaction-arrow": object.labels.forEach(id => check(id, "text")); break;
    case "text":
      if (object.arrowAttachment) check(object.arrowAttachment.parentObjectId);
      break;
    case "group":
      object.childObjectIds.forEach(id => check(id));
      if (hasGroupCycle(object.id, objects)) missing.push(object.id);
      break;
    case "annotation": object.targetObjectIds.forEach(id => check(id)); break;
    case "molecule": {
      const atoms = new Set(object.atoms.map(atom => atom.id));
      const bonds = new Set(object.bonds.map(bond => bond.id));
      if (atoms.size !== object.atoms.length || bonds.size !== object.bonds.length) missing.push(object.id);
      for (const bond of object.bonds) {
        if (!atoms.has(bond.fromAtomId) || !atoms.has(bond.toAtomId)) missing.push(bond.id);
      }
      for (const group of object.superatoms) {
        for (const id of group.atomIds ?? []) if (!atoms.has(id)) missing.push(id);
      }
      break;
    }
  }
  return missing;
}

/** Validate drafted references while allowing legacy defects in objects the preview did not edit. */
export function assertPreviewReferences(before: readonly DocumentObject[], after: readonly DocumentObject[],
  edited: ReadonlySet<string>): void {
  const original = new Map(before.map(object => [object.id, object]));
  const current = new Map(after.map(object => [object.id, object]));
  for (const object of after) {
    const missing = missingReferences(object, current);
    if (!missing.length) continue;
    const old = original.get(object.id);
    const previous = new Set(old && !edited.has(object.id) ? missingReferences(old, original) : []);
    const problem = missing.find(id => !previous.has(id));
    if (problem !== undefined) throw new RequestWriteError("invalid", `Invalid native reference "${problem}" in "${object.id}".`);
  }
}

function hasGroupCycle(id: string, objects: ReadonlyMap<string, DocumentObject>): boolean {
  // Iterative walk: long imported group chains must never exhaust the JS stack.
  const root = objects.get(id);
  if (root?.type !== "group") return false;
  const stack = [{ group: root, index: 0 }];
  const active = new Set([id]);
  const done = new Set<string>();
  while (stack.length) {
    const frame = stack[stack.length - 1]!;
    if (frame.index === frame.group.childObjectIds.length) {
      active.delete(frame.group.id);
      done.add(frame.group.id);
      stack.pop();
      continue;
    }
    const childId = frame.group.childObjectIds[frame.index++]!;
    if (active.has(childId)) return true;
    const child = objects.get(childId);
    if (child?.type === "group" && !done.has(childId)) {
      active.add(childId);
      stack.push({ group: child, index: 0 });
    }
  }
  return false;
}

function anchorGeometry(object: DocumentObject | undefined): unknown {
  if (!object) return null;
  const { x, y, width, height, rotation } = object;
  return object.type === "molecule"
    ? [x, y, width, height, rotation, object.transform, object.atoms.map(atom => [atom.id, atom.x, atom.y]),
      object.bonds.map(bond => [bond.id, bond.fromAtomId, bond.toAtomId])]
    : [x, y, width, height, rotation];
}

type CheckReferenceScope = NonNullable<ApplyPatchOptions["beforeObjectWrite"]>;

export function requestReferenceScope(grantedPages: ReadonlyMap<string, string>): CheckReferenceScope {
  return (pageId, previous, next) => {
    checkChangedObjectReferences(previous, next, id => {
      if (grantedPages.get(id) !== pageId) {
        throw new RequestWriteError("scope", `Reference to "${id}" in "${next.id}" is outside the request scope on page "${pageId}".`);
      }
    });
  };
}

/** Permit existing import defects, but refuse newly dangling native links and movement of an
 * anchored object unless the dependent annotation is also explicitly edited in the batch. */
export function assertRequestReferences(before: ChemDraftDocument, after: ChemDraftDocument,
  targets: ReadonlySet<string>, inserted: readonly string[], checkScope: CheckReferenceScope): void {
  const edited = new Set([...targets, ...inserted]);
  for (const page of after.pages) {
    const original = new Map(before.pages.find(old => old.id === page.id)?.objects.map(object => [object.id, object]));
    const current = new Map(page.objects.map(object => [object.id, object]));
    const moved = new Set([...targets].filter(id =>
      JSON.stringify(anchorGeometry(original.get(id))) !== JSON.stringify(anchorGeometry(current.get(id)))));
    for (const object of page.objects) {
      const old = original.get(object.id);
      if (object !== old) checkScope(page.id, old, object);
      const missing = missingReferences(object, current);
      const previousMissing = new Set(old && missing.length ? missingReferences(old, original) : []);
      const problem = missing.find(id => edited.has(object.id) || !previousMissing.has(id));
      if (problem !== undefined) throw new RequestWriteError("invalid", `Invalid native reference "${problem}" in "${object.id}".`);
      if (edited.has(object.id)) continue;
      const anchor = objectAnchors(object).find(anchor => anchor.kind !== "point" && anchor.objectId && moved.has(anchor.objectId));
      if (anchor) throw new RequestWriteError("scope", `Cannot safely change "${anchor.objectId}" without its anchored ${object.type} "${object.id}".`);
    }
  }
}


/** Chem-core repairs bracket membership during general patching. Refuse an authored request
 * reference that would be dropped by that repair, even when the bracket is in write scope. */
export function assertAuthoredBracketReferences(ops: readonly Exclude<DocumentPatch, { op: "batch" }>[],
  objects: ReadonlyMap<string, { object: DocumentObject }>): void {
  for (const op of ops) {
    const id = op.op === "addObject" ? op.object.id : op.op === "updateObject" ? op.objectId : undefined;
    const bracket = id && objects.get(id)?.object;
    if (!bracket || bracket.type !== "bracket") continue;
    const fields = op.op === "addObject" ? op.object : op.op === "updateObject" ? op.changes : {};
    if (("containedObjectIds" in fields && JSON.stringify(fields.containedObjectIds) !== JSON.stringify(bracket.containedObjectIds)) ||
        ("crossingBondIds" in fields && JSON.stringify(fields.crossingBondIds) !== JSON.stringify(bracket.crossingBondIds)) ||
        ("pairId" in fields && fields.pairId !== bracket.pairId)) {
      throw new RequestWriteError("invalid", `Bracket "${bracket.id}" contains an invalid or incomplete reference.`);
    }
  }
}
