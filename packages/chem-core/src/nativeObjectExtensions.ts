import type { ChemDraftDocument } from "./schemas";
import {
  compareNativeVersions, nativeExtensionObjectScope, nativeExtensionTarget, retainNativeExtension, type NativeExtension
} from "./nativeCompatibilityState";
import { adoptDerivedDocument, toEngineDocument } from "./patches";

/** Legacy chemistry classifiers use the explicit unknown marker; a foreign writer must not
 * mistake that active fallback for the source chemistry retained for native save. */
export function preservedNativeChemistryValues(document: ChemDraftDocument, objectIds: ReadonlySet<string>): unknown[] {
  return (document.compatibility.nativeExtensions ?? []).flatMap(extension => {
    const scope = nativeExtensionObjectScope(extension);
    const key = extension.path.at(-1);
    return scope && objectIds.has(scope.objectId) && extension.kind === "enum" && extension.fallbackValue === "unknown"
      && ["order", "structureFormat", "expandedStructureFormat", "mappingState", "arrowKind", "markKind", "bracketUsage"].includes(String(key))
      && nativeExtensionTarget(document, extension) ? [extension.originalValue] : [];
  });
}

/** Copy only state owned by copied objects, into their destination page/object scope. Nested IDs
 * stay local to the cloned object, just like atom/bond references in the graph. The resulting
 * document is one immutable snapshot, so undo/redo include both the objects and their source data. */
export function copyNativeObjectExtensions(
  source: ChemDraftDocument,
  destination: ChemDraftDocument,
  objectIds: ReadonlyMap<string, string>
): ChemDraftDocument {
  if (!source.compatibility.nativeExtensions?.length) return destination;
  const destinations = new Map(destination.pages.flatMap(page => page.objects.map(object => [object.id, page.id] as const)));
  const extensions: NativeExtension[] = [];
  for (const extension of source.compatibility.nativeExtensions) {
    const scope = nativeExtensionObjectScope(extension);
    const objectId = scope && objectIds.get(scope.objectId);
    const pageId = objectId && destinations.get(objectId);
    if (!objectId || !pageId) continue;
    const retained = retainNativeExtension(source, extension);
    if (!retained) continue;
    const copied = { ...retained, path: ["pages", { id: pageId }, "objects", { id: objectId }, ...retained.path.slice(4)] };
    // A fragment deliberately excludes some original atoms/bonds. Their state is not copied.
    const destinationExtension = retainNativeExtension(destination, copied);
    if (destinationExtension) extensions.push(structuredClone(destinationExtension));
  }
  if (!extensions.length) return destination;
  const base = toEngineDocument(destination);
  const next = { ...base, compatibility: { ...base.compatibility,
    nativeExtensions: [...(base.compatibility.nativeExtensions ?? []), ...extensions] } };
  for (const key of ["formatVersion", "minAppVersion"] as const) {
    const version = source[key];
    if (version && (!next[key] || compareNativeVersions(version, next[key]) > 0)) next[key] = version;
  }
  if (source.ignorableFields?.length) next.ignorableFields = [...new Set([...(next.ignorableFields ?? []), ...source.ignorableFields])];
  return adoptDerivedDocument(base, next);
}
