import {
  NativeStylePresets, SketchStylePreset, nativeDrawingStyleFromObjectStyle, nativeTextStyleFromObjectStyle, stylePresetToObjectStyle,
  type ChemDraftDocument, type DocumentObject, type DocumentPatch, type CompatibilityWarning,
  type DocumentPage, type MoleculeObject
} from "@chemdraft/chem-core";
import { moleculeTargetBondLengthChanges, representativeNativeMoleculeBondLength } from "./molecule";
import { isEditableNativeMoleculeGraph, nativeChargeMarkCenter, nativeElectronMarkAssignments,
  nativeElectronMarkAtomKey, type NativeElectronMarkAssignments } from "./electronMarks";

export type NativeStylePresetScope = "selection" | "document";

/**
 * Plan one atomic style edit. An empty batch means nothing changed; callers skip applying it.
 * Each molecule keeps its centre and chemical graph; associated electron marks follow its atoms.
 * Other object kinds are untouched. Unsafe molecule edits are skipped with a specific warning.
 * The selected page can select its changed objects; changes on other pages remain on those pages.
 */
export function applyNativeStylePreset(
  document: ChemDraftDocument, presetId: string, scope: NativeStylePresetScope,
  warnings: CompatibilityWarning[] = []
): Extract<DocumentPatch, { op: "batch" }> {
  const preset = NativeStylePresets.find(candidate => candidate.id === presetId);
  if (!preset) throw new Error(`Unknown native style preset "${presetId}".`);
  if (scope !== "selection" && scope !== "document") throw new Error(`Unknown style preset scope "${scope}".`);
  const page = document.pages.find(candidate => candidate.id === document.selection.pageId) ?? document.pages[0]!;
  const selected = new Set<string>();
  const objects = new Map(page.objects.map(object => [object.id, object]));
  const visit = (id: string) => {
    const object = objects.get(id);
    if (!object || selected.has(id)) return;
    selected.add(id);
    if (object.type === "group") object.childObjectIds.forEach(visit);
  };
  document.selection.objectIds.forEach(visit);
  const text = {
    fontFamily: preset.drawing.atomLabelFontFamily,
    fontSizePx: preset.drawing.atomLabelFontSizePx,
    fontWeight: preset.drawing.atomLabelFontWeight,
    // The bundled handwriting face is regular; avoid synthesizing an imported italic.
    ...(preset.id === SketchStylePreset.id ? { fontStyle: "normal" as const } : {})
  };
  const patches: DocumentPatch[] = [];
  const changedOnPage: string[] = [];
  for (const currentPage of document.pages) {
    const beforeAssignments = nativeElectronMarkAssignments(currentPage);
    let workingPage = currentPage;
    for (const object of currentPage.objects) {
      if (scope === "selection" && (currentPage.id !== page.id || !selected.has(object.id))) continue;
      let changes: Partial<DocumentObject>;
      let markPatches: Extract<DocumentPatch, { op: "updateObject" }>[] = [];
      if (object.type === "molecule") {
        // Presets own the sketch treatment; preserve independently authored art effects.
        const style = { ...object.style, ...stylePresetToObjectStyle(preset) };
        const effects = Array.isArray(object.style.visualEffects) ? object.style.visualEffects : [];
        const visualEffects = [
          ...effects.filter(effect => effect?.kind !== "sketch"),
          ...("visualEffects" in preset.drawing ? preset.drawing.visualEffects : [])
        ];
        if (visualEffects.length) style.visualEffects = visualEffects;
        else delete style.visualEffects;
        if (Array.isArray(style.effects)) {
          const remainingEffects = style.effects.filter(effect =>
            typeof effect !== "object" || effect === null || !("kind" in effect) || effect.kind !== "sketch");
          if (remainingEffects.length) style.effects = remainingEffects;
          else delete style.effects;
        }
        const geometryChanges = moleculeTargetBondLengthChanges(object, preset.drawing.bondLengthPx);
        changes = {
          ...geometryChanges,
          style
        };
        const scaled = { ...object, ...changes } as MoleculeObject;
        const representative = representativeNativeMoleculeBondLength(object);
        const scale = representative ? preset.drawing.bondLengthPx / representative : 1;
        // Resolve on the original geometry, including legacy point/atom anchors. Unassociated
        // marks remain where they were. Pin resolved anchors so a neighbour cannot steal them.
        if (geometryChanges.atoms) {
          const nextAtoms = new Map(scaled.atoms.map(atom => [atom.id, atom]));
          markPatches = currentPage.objects.flatMap(mark => {
            if (mark.type !== "electron-mark") return [];
            const anchor = beforeAssignments.anchorByMarkId.get(mark.id);
            if (anchor?.objectId !== object.id) return [];
            const atom = object.atoms.find(candidate => candidate.id === anchor.atomId)!;
            const next = nextAtoms.get(anchor.atomId)!;
            const centre = nativeChargeMarkCenter(mark);
            return [{ op: "updateObject" as const, objectId: mark.id, changes: {
              x: next.x + (centre.x - atom.x) * scale - mark.width / 2,
              y: next.y + (centre.y - atom.y) * scale - mark.height / 2,
              anchor: { kind: "atom" as const, objectId: object.id, atomId: atom.id }
            } }];
          });
        }
        // Without marks or recorded contributions, reconciliation cannot alter chemistry.
        // Keep ordinary mark-free documents linear rather than checking the page per molecule.
        if (beforeAssignments.anchorByMarkId.size || object.atoms.some(atom =>
          (atom.markCharge ?? 0) !== 0 || (atom.markRadicals ?? 0) !== 0)) {
          const candidates = new Map<string, DocumentObject>([[object.id, scaled]]);
          for (const patch of markPatches) {
            const mark = currentPage.objects.find(candidate => candidate.id === patch.objectId)!;
            candidates.set(mark.id, { ...mark, ...patch.changes } as DocumentObject);
          }
          const candidatePage = { ...workingPage,
            objects: workingPage.objects.map(candidate => candidates.get(candidate.id) ?? candidate) };
          const mismatch = presetChemistryMismatch(workingPage, candidatePage, object.id);
          if (mismatch) {
            warnings.push({ code: "style_preset.chemistry_change_refused", objectId: object.id,
              message: `Style preset "${preset.name}" was not applied to molecule "${object.id}": commit normalization would change ${mismatch}.` });
            continue;
          }
          workingPage = candidatePage;
        }
      } else if (object.type === "text") {
        changes = {
          style: { ...object.style, ...text, stylePresetId: preset.id },
          spans: object.spans.map(span => ({ ...span, style: { ...span.style, ...text } }))
        };
      } else continue;
      if (Object.entries(changes).every(([key, value]) =>
        JSON.stringify(object[key as keyof typeof object]) === JSON.stringify(value))) continue;
      patches.push({ op: "updateObject", objectId: object.id, changes });
      if (currentPage.id === page.id) changedOnPage.push(object.id);
      for (const patch of markPatches) {
        patches.push(patch);
        if (currentPage.id === page.id) changedOnPage.push(patch.objectId);
      }
    }
  }
  if (scope === "document") {
    const storedText = document.styles.text;
    const defaults = {
      drawing: nativeDrawingStyleFromObjectStyle({ ...preset.drawing }),
      text: { ...nativeTextStyleFromObjectStyle(storedText && typeof storedText === "object" && !Array.isArray(storedText)
        ? storedText as Record<string, unknown> : {}), ...text }
    };
    if (JSON.stringify(document.styles.drawing) !== JSON.stringify(defaults.drawing)
      || JSON.stringify(document.styles.text) !== JSON.stringify(defaults.text)) {
      patches.push({ op: "setDrawingDefaults", ...defaults });
    }
  }
  if (changedOnPage.length && JSON.stringify(document.selection.objectIds) !== JSON.stringify(changedOnPage)) {
    patches.push({ op: "setSelection", pageId: page.id, objectIds: changedOnPage });
  }
  return { op: "batch", patches };
}

function normalizedAtomChemistry(molecule: MoleculeObject, assignments: NativeElectronMarkAssignments) {
  return molecule.atoms.map(atom => {
    const key = nativeElectronMarkAtomKey(molecule.id, atom.id);
    const charge = assignments.assignedChargeByAtomKey.get(key) ?? 0;
    return { id: atom.id, formalCharge: atom.formalCharge - (atom.markCharge ?? 0) + charge,
      markCharge: charge, markRadicals: assignments.assignedRadicalsByAtomKey.get(key) ?? 0 };
  });
}

/** Check the exact atom fields the commit reconciler will write, including neighbouring molecules.
 * A pre-existing inconsistency elsewhere must not block an unrelated molecule's style change. */
function presetChemistryMismatch(before: DocumentPage, after: DocumentPage, targetId: string): string | undefined {
  const assignments = nativeElectronMarkAssignments(after);
  const beforeAssignments = nativeElectronMarkAssignments(before);
  for (const object of before.objects) {
    if (object.type !== "molecule" || !isEditableNativeMoleculeGraph(object)) continue;
    const next = after.objects.find(candidate => candidate.id === object.id) as MoleculeObject;
    const expected = object.id === targetId ? object.atoms.map(atom => ({ id: atom.id,
      formalCharge: atom.formalCharge, markCharge: atom.markCharge ?? 0, markRadicals: atom.markRadicals ?? 0
    })) : normalizedAtomChemistry(object, beforeAssignments);
    const normalized = normalizedAtomChemistry(next, assignments);
    for (const [index, atom] of expected.entries()) {
      const changed = normalized[index]!;
      for (const field of ["formalCharge", "markCharge", "markRadicals"] as const) {
        if (atom[field] !== changed[field]) {
          return `atom "${atom.id}" in molecule "${object.id}" (${field}: ${atom[field]} → ${changed[field]})`;
        }
      }
    }
  }
}
