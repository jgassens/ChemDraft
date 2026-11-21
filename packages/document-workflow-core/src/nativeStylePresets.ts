import {
  NativeStylePresets, SketchStylePreset, nativeDrawingStyleFromObjectStyle, nativeTextStyleFromObjectStyle, stylePresetToObjectStyle,
  type ChemDraftDocument, type DocumentObject, type DocumentPatch, type CompatibilityWarning,
  type DocumentPage, type ElectronMarkObject, type MoleculeObject
} from "@chemdraft/chem-core";
import { transformPointForObject } from "@chemdraft/layout-engine";
import { moleculeTargetBondLengthChanges, representativeNativeMoleculeBondLength } from "./molecule";
import { isEditableNativeMoleculeGraph, nativeChargeMarkCenter, nativeElectronMarkAssignments,
  nativeElectronMarkAtomKey, type NativeElectronMarkAssignments } from "./electronMarks";

export type NativeStylePresetScope = "selection" | "document";
type StylePreset = typeof NativeStylePresets[number];
type StyleUpdate = Extract<DocumentPatch, { op: "updateObject" }>;

export function findNativeStylePreset(presetId: string): StylePreset {
  const preset = NativeStylePresets.find(candidate => candidate.id === presetId);
  if (!preset) throw new Error(`Unknown native style preset "${presetId}".`);
  return preset;
}

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
  const preset = findNativeStylePreset(presetId);
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
  const text = presetTextStyle(preset);
  const patches: DocumentPatch[] = [];
  const changedOnPage: string[] = [];
  for (const currentPage of document.pages) {
    if (scope === "selection" && currentPage.id !== page.id) continue;
    const updates = planPageStyleUpdates(currentPage, scope === "selection" ? selected : undefined, preset, undefined, warnings);
    patches.push(...updates);
    if (currentPage.id === page.id) changedOnPage.push(...updates.map(update => update.objectId));
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

function presetTextStyle(preset: StylePreset) {
  return {
    fontFamily: preset.drawing.atomLabelFontFamily,
    fontSizePx: preset.drawing.atomLabelFontSizePx,
    fontWeight: preset.drawing.atomLabelFontWeight,
    // The bundled handwriting face is regular; avoid synthesizing an imported italic.
    ...(preset.id === SketchStylePreset.id ? { fontStyle: "normal" as const } : {})
  };
}

/** Per-page proposals shared by the native preset command and explicit figure plans. */
export function planPageStyleUpdates(
  currentPage: DocumentPage,
  targets: ReadonlySet<string> | undefined,
  preset: StylePreset | undefined,
  targetBondLength: number | undefined,
  warnings: CompatibilityWarning[],
  explicitTargets = false
): StyleUpdate[] {
  const bondLengthPx = targetBondLength ?? preset?.drawing.bondLengthPx;
  if (bondLengthPx === undefined) return [];
  const text = preset && presetTextStyle(preset);
  const patches: StyleUpdate[] = [];
  const beforeAssignments = nativeElectronMarkAssignments(currentPage);
  const marksByMolecule = new Map<string, ElectronMarkObject[]>();
  for (const mark of currentPage.objects) {
    if (mark.type !== "electron-mark") continue;
    const owner = beforeAssignments.anchorByMarkId.get(mark.id)?.objectId;
    if (!owner) continue;
    const marks = marksByMolecule.get(owner);
    if (marks) marks.push(mark);
    else marksByMolecule.set(owner, [mark]);
  }
  let workingPage = currentPage;
  for (const object of currentPage.objects) {
    if (targets && !targets.has(object.id)) continue;
    let changes: Partial<DocumentObject>;
    let markPatches: StyleUpdate[] = [];
    if (object.type === "molecule") {
      const marks = marksByMolecule.get(object.id) ?? [];
      const missingMarks = explicitTargets ? marks.filter(mark => !targets?.has(mark.id)) : [];
      if (missingMarks.length) {
        warnings.push({ code: "style_preset.missing_marks", objectId: object.id,
          message: `Molecule "${object.id}" requires electron marks among the targets: ${missingMarks.map(mark => mark.id).join(", ")}.` });
        continue;
      }
      const representative = representativeNativeMoleculeBondLength(object);
      if (targetBondLength !== undefined && !representative) {
        warnings.push({ code: "style_preset.no_measurable_bond", objectId: object.id,
          message: `Molecule "${object.id}" has no measurable bond length.` });
        if (!preset) continue;
      }
      const geometryChanges = explicitTargets && !representative ? {} :
        moleculeTargetBondLengthChanges(object, bondLengthPx, { preserveFrameCenter: explicitTargets });
      changes = geometryChanges;
      if (preset) {
        // Presets own the sketch treatment; preserve independently authored art effects.
        const style: MoleculeObject["style"] = { ...object.style, ...stylePresetToObjectStyle(preset), bondLengthPx };
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
        changes = { ...geometryChanges, style };
      }
      const scaled = { ...object, ...changes } as MoleculeObject;
      const scale = representative ? bondLengthPx / representative : 1;
      // Resolve on the original geometry, including legacy point/atom anchors. Unassociated
      // marks remain where they were. Pin resolved anchors so a neighbour cannot steal them.
      if (geometryChanges.atoms) {
        const nextAtoms = new Map(scaled.atoms.map(atom => [atom.id, atom]));
        markPatches = marks.map(mark => {
          const anchor = beforeAssignments.anchorByMarkId.get(mark.id)!;
          const atom = object.atoms.find(candidate => candidate.id === anchor.atomId)!;
          const previousPosition = transformPointForObject(object, atom);
          const nextPosition = transformPointForObject(scaled, nextAtoms.get(anchor.atomId)!);
          const centre = nativeChargeMarkCenter(mark);
          return { op: "updateObject", objectId: mark.id, changes: {
            x: nextPosition.x + (centre.x - previousPosition.x) * scale - mark.width / 2,
            y: nextPosition.y + (centre.y - previousPosition.y) * scale - mark.height / 2,
            anchor: { kind: "atom" as const, objectId: object.id, atomId: atom.id }
          } };
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
            message: `Skipped a structure because it would change a ${mismatch}.` });
          continue;
        }
        workingPage = candidatePage;
      }
    } else if (object.type === "text" && preset && text) {
      changes = {
        style: { ...object.style, ...text, stylePresetId: preset.id },
        spans: object.spans.map(span => ({ ...span, style: { ...span.style, ...text } }))
      };
    } else continue;
    if (Object.entries(changes).every(([key, value]) =>
      JSON.stringify(object[key as keyof typeof object]) === JSON.stringify(value))) continue;
    patches.push({ op: "updateObject", objectId: object.id, changes });
    patches.push(...markPatches);
  }
  return patches;
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
          return field === "markRadicals" ? "radical" : "charge";
        }
      }
    }
  }
  for (const [markId, anchor] of beforeAssignments.anchorByMarkId) {
    const next = assignments.anchorByMarkId.get(markId);
    if (anchor?.objectId !== next?.objectId || anchor?.atomId !== next?.atomId) {
      return `mark association for "${markId}"`;
    }
  }
}
