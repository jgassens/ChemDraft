import { visualEffectsForStyle } from "@chemdraft/art-engine";
import {
  DefaultNativeDrawingStyle,
  nativeDrawingStyleFromObjectStyle,
  type ChemDraftDocument,
  type GraphicPaint,
  type MoleculeObject,
  type NativeAtomLabelAlignment,
  type NativeAtomLabelPlacement,
  type NativeBondLineCap,
  type NativeBondSpacingMode,
  type NativeTextFontStyle,
  type VisualEffect
} from "@chemdraft/chem-core";
import {
  atomDisplayLabel,
  nativeMoleculeAtomIndicatorStyle,
  nativeMoleculeBondDrawingStyle,
  nativeMoleculeRings
} from "@chemdraft/layout-engine";
import type {
  ArtInspectorEffectKind,
  ArtInspectorEffectModel,
  ArtInspectorEffectValue,
  ArtInspectorMixedValue
} from "./artInspectorModel";
import { normalizeNativeAtomElementLabel } from "./documentWorkflow";

export type MoleculeInspectorTabId = "structure" | "atom-labels" | "templates";
export type MoleculeInspectorContext = "none" | "molecule" | "ring" | "bond" | "atom";

export interface MoleculeInspectorRingSelection {
  objectId: string;
  kind: "ring";
  ringKey: string;
  atomIds: readonly string[];
  bondIds: readonly string[];
}

export interface MoleculeInspectorAtomLabelTarget {
  objectId: string;
  atomId: string;
}

export interface MoleculeInspectorBondTarget {
  objectId: string;
  bondId: string;
}

export interface MoleculeInspectorTargets {
  moleculeObjectIds: readonly string[];
  ringTargets: readonly MoleculeInspectorRingSelection[];
  atomTargets: readonly MoleculeInspectorAtomLabelTarget[];
  bondTargets: readonly MoleculeInspectorBondTarget[];
  atomLabelTargets: readonly MoleculeInspectorAtomLabelTarget[];
  context: MoleculeInspectorContext;
}

export interface MoleculeInspectorRingsModel {
  enabled: boolean;
  selectedCount: number;
  selectedRing?: MoleculeInspectorRingSelection;
  selectedRings: readonly MoleculeInspectorRingSelection[];
  effectKinds: readonly ArtInspectorEffectKind[];
  values: {
    fillPaintType: ArtInspectorMixedValue<"none" | "solid">;
    fillColor: ArtInspectorMixedValue<string>;
    fillOpacity: ArtInspectorMixedValue<number>;
    effect: ArtInspectorMixedValue<ArtInspectorEffectValue>;
  };
  effectControls: Record<ArtInspectorEffectKind, ArtInspectorEffectModel>;
}

export interface MoleculeInspectorStructureModel {
  enabled: boolean;
  targetCount: number;
  targetKind: "molecule" | "atom" | "bond";
  values: {
    chainAngleDegrees: ArtInspectorMixedValue<number>;
    bondLengthPx: ArtInspectorMixedValue<number>;
    bondStrokeWidthPx: ArtInspectorMixedValue<number>;
    bondBoldWidthPx: ArtInspectorMixedValue<number>;
    bondColor: ArtInspectorMixedValue<string>;
    bondLineCap: ArtInspectorMixedValue<NativeBondLineCap>;
    bondSpacingMode: ArtInspectorMixedValue<NativeBondSpacingMode>;
    bondSpacingPercent: ArtInspectorMixedValue<number>;
    multipleBondGapPx: ArtInspectorMixedValue<number>;
    doubleBondInsetPx: ArtInspectorMixedValue<number>;
    bondMarginWidthPx: ArtInspectorMixedValue<number>;
    bondHashSpacingPx: ArtInspectorMixedValue<number>;
    bondOverlapClearancePx: ArtInspectorMixedValue<number>;
    atomIndicatorShowQuery: ArtInspectorMixedValue<boolean>;
    atomIndicatorShowStereochemistry: ArtInspectorMixedValue<boolean>;
    atomIndicatorShowEnhancedStereochemistry: ArtInspectorMixedValue<boolean>;
    atomIndicatorShowAtomNumbers: ArtInspectorMixedValue<boolean>;
    bondIndicatorShowQuery: ArtInspectorMixedValue<boolean>;
    bondIndicatorShowStereochemistry: ArtInspectorMixedValue<boolean>;
    bondIndicatorShowReaction: ArtInspectorMixedValue<boolean>;
  };
}

export interface MoleculeInspectorFontFace {
  weight: number;
  style: NativeTextFontStyle;
}

export interface MoleculeInspectorAtomLabelsModel {
  enabled: boolean;
  targetCount: number;
  targetKind: "molecule" | "atom";
  /** Whether toggling implicit hydrogens would change anything the canvas draws. Plain bonded
   *  carbons render no label at all, so on a skeletal structure the control is inert — surfaces
   *  say so instead of offering a toggle whose effect never appears. */
  implicitHydrogensAffectLabels: boolean;
  values: {
    fontFamily: ArtInspectorMixedValue<string>;
    fontFace: ArtInspectorMixedValue<MoleculeInspectorFontFace>;
    fontSizePx: ArtInspectorMixedValue<number>;
    color: ArtInspectorMixedValue<string>;
    backgroundColor: ArtInspectorMixedValue<string>;
    paddingPx: ArtInspectorMixedValue<number>;
    bondClearancePx: ArtInspectorMixedValue<number>;
    alignment: ArtInspectorMixedValue<NativeAtomLabelAlignment>;
    placement: ArtInspectorMixedValue<NativeAtomLabelPlacement>;
    showTerminalCarbons: ArtInspectorMixedValue<boolean>;
    hideImplicitHydrogens: ArtInspectorMixedValue<boolean>;
  };
}

export interface MoleculeInspectorModel {
  targets: MoleculeInspectorTargets;
  suggestedTab: MoleculeInspectorTabId;
  rings: MoleculeInspectorRingsModel;
  structure: MoleculeInspectorStructureModel;
  atomLabels: MoleculeInspectorAtomLabelsModel;
}

export type MoleculeInspectorPartSelection =
  | { objectId: string; kind: "atom"; atomId: string }
  | { objectId: string; kind: "bond"; bondId: string }
  | { objectId: string; kind: "ring"; ringKey: string; atomIds?: readonly string[]; bondIds?: readonly string[] }
  | { objectId: string; kind: "rings"; rings?: readonly { ringKey: string; atomIds?: readonly string[]; bondIds?: readonly string[] }[] }
  | { objectId: string; kind: "parts"; atomIds?: readonly string[]; bondIds?: readonly string[] };

export interface MoleculeInspectorSelectionInput {
  selectedObjectIds: readonly string[];
  selectedPart?: MoleculeInspectorPartSelection;
  selectedParts?: readonly MoleculeInspectorPartSelection[];
}

type MoleculeInspectorRingEntry = {
  object: MoleculeObject;
  ring: ReturnType<typeof nativeMoleculeRings>[number];
  style: Record<string, unknown>;
  fillPaint: GraphicPaint;
  effects: readonly VisualEffect[];
};

export function createMoleculeInspectorModel(
  document: ChemDraftDocument,
  selection: MoleculeInspectorSelectionInput = { selectedObjectIds: [] }
): MoleculeInspectorModel {
  const targets = resolveMoleculeInspectorTargets(document, selection);
  const targetObjects = moleculeObjectsForTargets(document, targets.moleculeObjectIds);

  return {
    targets,
    suggestedTab: suggestedTabForContext(targets.context),
    rings: createRingsModel(targetObjects, targets.ringTargets),
    structure: createStructureModel(targetObjects, targets.atomTargets, targets.bondTargets),
    atomLabels: createAtomLabelsModel(targetObjects, targets.atomLabelTargets)
  };
}

export function resolveMoleculeInspectorTargets(
  document: ChemDraftDocument,
  selection: MoleculeInspectorSelectionInput
): MoleculeInspectorTargets {
  const molecules = document.pages
    .flatMap((page) => page.objects)
    .filter((object): object is MoleculeObject => object.type === "molecule");
  const moleculeById = new Map(molecules.map((object) => [object.id, object]));
  const selectedMoleculeIds = new Set(
    selection.selectedObjectIds.filter((objectId) => moleculeById.has(objectId))
  );
  const selectedParts = selection.selectedParts?.length
    ? selection.selectedParts
    : selection.selectedPart ? [selection.selectedPart] : [];
  const selectedPartEntries = selectedParts.flatMap((selectedPart) => {
    const object = moleculeById.get(selectedPart.objectId);
    return object ? [{ object, selectedPart }] : [];
  });
  for (const { object } of selectedPartEntries) {
    selectedMoleculeIds.add(object.id);
  }

  const moleculeObjectIds = molecules
    .map((object) => object.id)
    .filter((objectId) => selectedMoleculeIds.has(objectId));
  const seenRingTargets = new Set<string>();
  const ringTargets = selectedPartEntries.flatMap(({ object, selectedPart }) =>
    ringTargetsForPart(object, selectedPart).flatMap((ringTarget) => {
      const key = `${ringTarget.objectId}:${ringTarget.ringKey}`;
      if (seenRingTargets.has(key)) {
        return [];
      }
      seenRingTargets.add(key);
      return [ringTarget];
    })
  );
  const seenAtomLabelTargets = new Set<string>();
  const atomTargets = selectedPartEntries.flatMap(({ object, selectedPart }) =>
    atomTargetsForPart(object, selectedPart).flatMap((target) => {
      const key = `${target.objectId}:${target.atomId}`;
      if (seenAtomLabelTargets.has(key)) {
        return [];
      }
      seenAtomLabelTargets.add(key);
      return [target];
    })
  );
  const seenBondTargets = new Set<string>();
  const bondTargets = selectedPartEntries.flatMap(({ object, selectedPart }) =>
    bondTargetsForPart(object, selectedPart).flatMap((target) => {
      const key = `${target.objectId}:${target.bondId}`;
      if (seenBondTargets.has(key)) {
        return [];
      }
      seenBondTargets.add(key);
      return [target];
    })
  );
  const atomLabelTargets = atomTargets;
  const primaryPart = selectedPartEntries.find(({ selectedPart }) => selectedPart === selection.selectedPart)
    ?? selectedPartEntries[selectedPartEntries.length - 1];

  return {
    moleculeObjectIds,
    ringTargets,
    atomTargets,
    bondTargets,
    atomLabelTargets,
    context: primaryPart
      ? contextForPart(primaryPart.selectedPart)
      : moleculeObjectIds.length > 0 ? "molecule" : "none"
  };
}

export function representativeMoleculeBondLengthPx(object: MoleculeObject): number {
  const atomById = new Map(object.atoms.map((atom) => [atom.id, atom]));
  const heavyDistances: number[] = [];
  const allDistances: number[] = [];
  for (const bond of object.bonds) {
    const from = atomById.get(bond.fromAtomId);
    const to = atomById.get(bond.toAtomId);
    if (!from || !to) {
      continue;
    }
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    if (!Number.isFinite(distance) || distance <= 0) {
      continue;
    }
    allDistances.push(distance);
    if (normalizeNativeAtomElementLabel(from.element) !== "H" && normalizeNativeAtomElementLabel(to.element) !== "H") {
      heavyDistances.push(distance);
    }
  }

  return median(heavyDistances.length > 0 ? heavyDistances : allDistances) ??
    nativeDrawingStyleFromObjectStyle(object.style).bondLengthPx;
}

function createRingsModel(
  targetObjects: readonly MoleculeObject[],
  ringTargets: readonly MoleculeInspectorRingSelection[]
): MoleculeInspectorRingsModel {
  if (ringTargets.length === 0) {
    return emptyRingsModel();
  }

  const objectById = new Map(targetObjects.map((object) => [object.id, object]));
  const entries = ringTargets.flatMap((target): MoleculeInspectorRingEntry[] => {
    const object = objectById.get(target.objectId);
    if (!object) {
      return [];
    }
    const ring = nativeMoleculeRings(object).find((candidate) => candidate.ringKey === target.ringKey);
    if (!ring) {
      return [];
    }
    const style = moleculeRingStyle(object, ring.ringKey);
    return [{
      object,
      ring,
      style,
      fillPaint: moleculeRingFillPaint(object, style),
      effects: visualEffectsForStyle(style)
    }];
  });
  if (entries.length === 0) {
    return emptyRingsModel();
  }

  const effectControls = {
    shadow: effectModelForKind(entries, "shadow"),
    glow: effectModelForKind(entries, "glow"),
    sketch: effectModelForKind(entries, "sketch")
  } satisfies Record<ArtInspectorEffectKind, ArtInspectorEffectModel>;
  const selectedRings = entries.map(({ object, ring }) => ({
    objectId: object.id,
    kind: "ring" as const,
    ringKey: ring.ringKey,
    atomIds: ring.atomIds,
    bondIds: ring.bondIds
  }));

  return {
    enabled: true,
    selectedCount: selectedRings.length,
    selectedRing: selectedRings[0],
    selectedRings,
    effectKinds: (["shadow", "glow", "sketch"] as const).filter((kind) => effectControls[kind].presentCount > 0),
    values: {
      fillPaintType: uniformValue(entries, (entry) => entry.fillPaint.kind === "none" ? "none" : "solid"),
      fillColor: uniformValue(entries, (entry) => entry.fillPaint.kind === "solid"
        ? normalizeHexString(entry.fillPaint.color) ?? entry.fillPaint.color
        : moleculeFillBaseColor(entry.object)),
      fillOpacity: uniformValue(entries, (entry) => moleculeRingFillOpacity(entry.object, entry.style, entry.fillPaint)),
      effect: uniformValue(entries, (entry) => ringEffectValue(entry.effects))
    },
    effectControls
  };
}

function createStructureModel(
  targetObjects: readonly MoleculeObject[],
  atomTargets: readonly MoleculeInspectorAtomLabelTarget[],
  bondTargets: readonly MoleculeInspectorBondTarget[]
): MoleculeInspectorStructureModel {
  const objectById = new Map(targetObjects.map((object) => [object.id, object]));
  const bondEntries = bondTargets.flatMap((target) => {
    const object = objectById.get(target.objectId);
    if (!object?.bonds.some((bond) => bond.id === target.bondId)) {
      return [];
    }
    return [{ object, style: nativeMoleculeBondDrawingStyle(object, target.bondId) }];
  });
  const atomEntries = atomTargets.flatMap((target) => {
    const object = objectById.get(target.objectId);
    if (!object?.atoms.some((atom) => atom.id === target.atomId)) {
      return [];
    }
    return [{ object, style: nativeMoleculeAtomIndicatorStyle(object, target.atomId) }];
  });
  const moleculeEntries = targetObjects.map((object) => ({
    object,
    style: nativeDrawingStyleFromObjectStyle(object.style)
  }));
  const bondStyleEntries = bondEntries.length > 0 ? bondEntries : moleculeEntries;
  const atomIndicatorEntries = atomEntries.length > 0 ? atomEntries : moleculeEntries;
  const targetKind = bondEntries.length > 0
    ? "bond"
    : atomEntries.length > 0 ? "atom" : "molecule";
  const targetCount = targetKind === "bond"
    ? bondEntries.length
    : targetKind === "atom" ? atomEntries.length : moleculeEntries.length;
  const fallback = DefaultNativeDrawingStyle;

  return {
    enabled: targetCount > 0,
    targetCount,
    targetKind,
    values: {
      chainAngleDegrees: uniformValue(moleculeEntries, ({ style }) => style.chainAngleDegrees, fallback.chainAngleDegrees),
      bondLengthPx: uniformValue(
        bondEntries.length > 0 ? bondStyleEntries : moleculeEntries,
        ({ object, style }) => bondEntries.length > 0 ? style.bondLengthPx : representativeMoleculeBondLengthPx(object),
        fallback.bondLengthPx
      ),
      bondStrokeWidthPx: uniformValue(bondStyleEntries, ({ style }) => style.bondStrokeWidthPx, fallback.bondStrokeWidthPx),
      bondBoldWidthPx: uniformValue(bondStyleEntries, ({ style }) => style.bondBoldWidthPx, fallback.bondBoldWidthPx),
      bondColor: uniformValue(
        bondStyleEntries,
        ({ style }) => normalizeHexString(style.bondColor) ?? style.bondColor,
        fallback.bondColor
      ),
      bondLineCap: uniformValue(bondStyleEntries, ({ style }) => style.bondLineCap, fallback.bondLineCap),
      bondSpacingMode: uniformValue(bondStyleEntries, ({ style }) => style.bondSpacingMode, fallback.bondSpacingMode),
      bondSpacingPercent: uniformValue(bondStyleEntries, ({ style }) => style.bondSpacingPercent, fallback.bondSpacingPercent),
      multipleBondGapPx: uniformValue(bondStyleEntries, ({ style }) => style.multipleBondGapPx, fallback.multipleBondGapPx),
      doubleBondInsetPx: uniformValue(bondStyleEntries, ({ style }) => style.doubleBondInsetPx, fallback.doubleBondInsetPx),
      bondMarginWidthPx: uniformValue(bondStyleEntries, ({ style }) => style.bondMarginWidthPx, fallback.bondMarginWidthPx),
      bondHashSpacingPx: uniformValue(bondStyleEntries, ({ style }) => style.bondHashSpacingPx, fallback.bondHashSpacingPx),
      bondOverlapClearancePx: uniformValue(bondStyleEntries, ({ style }) => style.bondOverlapClearancePx, fallback.bondOverlapClearancePx),
      atomIndicatorShowQuery: uniformValue(
        atomIndicatorEntries,
        ({ style }) => style.atomIndicatorShowQuery,
        fallback.atomIndicatorShowQuery
      ),
      atomIndicatorShowStereochemistry: uniformValue(
        atomIndicatorEntries,
        ({ style }) => style.atomIndicatorShowStereochemistry,
        fallback.atomIndicatorShowStereochemistry
      ),
      atomIndicatorShowEnhancedStereochemistry: uniformValue(
        atomIndicatorEntries,
        ({ style }) => style.atomIndicatorShowEnhancedStereochemistry,
        fallback.atomIndicatorShowEnhancedStereochemistry
      ),
      atomIndicatorShowAtomNumbers: uniformValue(
        atomIndicatorEntries,
        ({ style }) => style.atomIndicatorShowAtomNumbers,
        fallback.atomIndicatorShowAtomNumbers
      ),
      bondIndicatorShowQuery: uniformValue(
        bondStyleEntries,
        ({ style }) => style.bondIndicatorShowQuery,
        fallback.bondIndicatorShowQuery
      ),
      bondIndicatorShowStereochemistry: uniformValue(
        bondStyleEntries,
        ({ style }) => style.bondIndicatorShowStereochemistry,
        fallback.bondIndicatorShowStereochemistry
      ),
      bondIndicatorShowReaction: uniformValue(
        bondStyleEntries,
        ({ style }) => style.bondIndicatorShowReaction,
        fallback.bondIndicatorShowReaction
      )
    }
  };
}

function createAtomLabelsModel(
  targetObjects: readonly MoleculeObject[],
  atomLabelTargets: readonly MoleculeInspectorAtomLabelTarget[]
): MoleculeInspectorAtomLabelsModel {
  const objectById = new Map(targetObjects.map((object) => [object.id, object]));
  const atomEntries = atomLabelTargets.flatMap((target) => {
    const object = objectById.get(target.objectId);
    if (!object?.atoms.some((atom) => atom.id === target.atomId)) {
      return [];
    }
    return [nativeMoleculeAtomLabelStyle(object, target.atomId)];
  });
  const targetKind = atomEntries.length > 0 ? "atom" : "molecule";
  const entries = atomEntries.length > 0
    ? atomEntries
    : targetObjects.map((object) => nativeDrawingStyleFromObjectStyle(object.style));
  const fallback = DefaultNativeDrawingStyle;

  return {
    enabled: entries.length > 0,
    targetCount: entries.length,
    targetKind,
    implicitHydrogensAffectLabels: implicitHydrogensAffectLabels(targetObjects, atomLabelTargets),
    values: {
      fontFamily: uniformValue(entries, (style) => style.atomLabelFontFamily, fallback.atomLabelFontFamily),
      fontFace: uniformValue(
        entries,
        (style) => ({ weight: style.atomLabelFontWeight, style: style.atomLabelFontStyle }),
        { weight: fallback.atomLabelFontWeight, style: fallback.atomLabelFontStyle },
        fontFacesEqual
      ),
      fontSizePx: uniformValue(entries, (style) => style.atomLabelFontSizePx, fallback.atomLabelFontSizePx),
      color: uniformValue(entries, (style) => normalizeHexString(style.atomLabelColor) ?? style.atomLabelColor, fallback.atomLabelColor),
      backgroundColor: uniformValue(
        entries,
        (style) => normalizeHexString(style.atomLabelBackgroundColor) ?? style.atomLabelBackgroundColor,
        fallback.atomLabelBackgroundColor
      ),
      paddingPx: uniformValue(entries, (style) => style.atomLabelPaddingPx, fallback.atomLabelPaddingPx),
      bondClearancePx: uniformValue(entries, (style) => style.atomLabelBondClearancePx, fallback.atomLabelBondClearancePx),
      alignment: uniformValue(entries, (style) => style.atomLabelAlignment, fallback.atomLabelAlignment),
      placement: uniformValue(entries, (style) => style.atomLabelPlacement, fallback.atomLabelPlacement),
      showTerminalCarbons: uniformValue(
        entries,
        (style) => style.atomLabelShowTerminalCarbons,
        fallback.atomLabelShowTerminalCarbons
      ),
      hideImplicitHydrogens: uniformValue(
        entries,
        (style) => style.atomLabelHideImplicitHydrogens,
        fallback.atomLabelHideImplicitHydrogens
      )
    }
  };
}

function emptyRingsModel(): MoleculeInspectorRingsModel {
  return {
    enabled: false,
    selectedCount: 0,
    selectedRings: [],
    effectKinds: [],
    values: {
      fillPaintType: { value: "solid", mixed: false },
      fillColor: { value: DefaultNativeDrawingStyle.bondColor, mixed: false },
      fillOpacity: { value: 1, mixed: false },
      effect: { value: "none", mixed: false }
    },
    effectControls: {
      shadow: emptyEffectModel("shadow"),
      glow: emptyEffectModel("glow"),
      sketch: emptyEffectModel("sketch")
    }
  };
}

function emptyEffectModel(kind: ArtInspectorEffectKind): ArtInspectorEffectModel {
  return {
    kind,
    presentCount: 0,
    presentAll: false,
    color: { value: "#52616b", mixed: false },
    opacity: { value: 1, mixed: false },
    size: { value: 0.25, mixed: false }
  };
}

function ringTargetsForPart(
  object: MoleculeObject,
  selectedPart: MoleculeInspectorPartSelection
): MoleculeInspectorRingSelection[] {
  if (selectedPart.kind !== "ring" && selectedPart.kind !== "rings") {
    return [];
  }

  const requestedKeys = selectedPart.kind === "ring"
    ? [selectedPart.ringKey]
    : (selectedPart.rings ?? []).map((ring) => ring.ringKey);
  const requested = new Set(requestedKeys);
  const seen = new Set<string>();
  return nativeMoleculeRings(object)
    .filter((ring) => requested.has(ring.ringKey))
    .sort((first, second) => first.ringKey.localeCompare(second.ringKey))
    .flatMap((ring) => {
      const key = `${object.id}::${ring.ringKey}`;
      if (seen.has(key)) {
        return [];
      }
      seen.add(key);
      return [{
        objectId: object.id,
        kind: "ring" as const,
        ringKey: ring.ringKey,
        atomIds: ring.atomIds,
        bondIds: ring.bondIds
      }];
    });
}

function atomTargetsForPart(
  object: MoleculeObject,
  selectedPart: MoleculeInspectorPartSelection
): MoleculeInspectorAtomLabelTarget[] {
  const requestedAtomIds = selectedPart.kind === "atom"
    ? [selectedPart.atomId]
    : selectedPart.kind === "parts"
      ? selectedPart.atomIds ?? []
      : [];
  if (requestedAtomIds.length === 0) {
    return [];
  }

  const requested = new Set(requestedAtomIds);
  return object.atoms
    .filter((atom) => requested.has(atom.id))
    .map((atom) => ({ objectId: object.id, atomId: atom.id }));
}

function bondTargetsForPart(
  object: MoleculeObject,
  selectedPart: MoleculeInspectorPartSelection
): MoleculeInspectorBondTarget[] {
  const requestedBondIds = selectedPart.kind === "bond"
    ? [selectedPart.bondId]
    : selectedPart.kind === "parts"
      ? selectedPart.bondIds ?? []
      : [];
  if (requestedBondIds.length === 0) {
    return [];
  }

  const requested = new Set(requestedBondIds);
  return object.bonds
    .filter((bond) => requested.has(bond.id))
    .map((bond) => ({ objectId: object.id, bondId: bond.id }));
}

function moleculeObjectsForTargets(
  document: ChemDraftDocument,
  objectIds: readonly string[]
): MoleculeObject[] {
  const targetIds = new Set(objectIds);
  return document.pages.flatMap((page) =>
    page.objects.filter((object): object is MoleculeObject =>
      object.type === "molecule" && targetIds.has(object.id)
    )
  );
}

function contextForPart(selectedPart: MoleculeInspectorPartSelection): MoleculeInspectorContext {
  switch (selectedPart.kind) {
    case "ring":
    case "rings":
      return "ring";
    case "atom":
      return "atom";
    case "bond":
      return "bond";
    case "parts":
      if ((selectedPart.atomIds?.length ?? 0) > 0 && (selectedPart.bondIds?.length ?? 0) === 0) {
        return "atom";
      }
      if ((selectedPart.bondIds?.length ?? 0) > 0 && (selectedPart.atomIds?.length ?? 0) === 0) {
        return "bond";
      }
      return "molecule";
    default: {
      const _exhaustive: never = selectedPart;
      return _exhaustive;
    }
  }
}

function suggestedTabForContext(context: MoleculeInspectorContext): MoleculeInspectorTabId {
  if (context === "atom") {
    return "atom-labels";
  }
  return "structure";
}

function uniformValue<TEntry, T>(
  entries: readonly TEntry[],
  read: (entry: TEntry) => T | null | undefined,
  fallback?: T,
  equals: (first: T, second: T) => boolean = Object.is
): ArtInspectorMixedValue<T> {
  // Single pass, no intermediate arrays: this runs ~20 times per structure-model
  // rebuild (once per field) over the same entries, so avoiding the map/filter/rest
  // allocations here removes the bulk of that per-keystroke cost.
  let first: T | undefined;
  let hasValue = false;
  let mixed = false;
  for (const entry of entries) {
    const value = read(entry);
    if (value === null || value === undefined) {
      continue;
    }
    if (!hasValue) {
      first = value;
      hasValue = true;
    } else if (!mixed && !equals(value, first as T)) {
      mixed = true;
    }
  }
  if (!hasValue) {
    return fallback === undefined ? { value: null, mixed: false } : { value: fallback, mixed: false };
  }
  return {
    value: mixed ? null : (first as T),
    mixed
  };
}

function effectModelForKind(
  entries: readonly MoleculeInspectorRingEntry[],
  kind: ArtInspectorEffectKind
): ArtInspectorEffectModel {
  const effects = entries.map((entry) => entry.effects.find((candidate) => candidate.kind === kind));
  const presentCount = effects.filter(Boolean).length;
  if (presentCount === 0) {
    return emptyEffectModel(kind);
  }
  const effectEntries = effects.map((effect, index) => ({ effect, entry: entries[index] }));
  const supported = effectEntries.map(({ effect }) => effect !== undefined);

  return {
    kind,
    presentCount,
    presentAll: entries.length > 0 && presentCount === entries.length,
    color: uniformEffectValue(effectEntries, supported, ({ effect }) => metadataString(effect?.color) ?? "#52616b"),
    opacity: uniformEffectValue(effectEntries, supported, ({ effect }) => clampUnit(metadataNumber(effect?.opacity) ?? 1)),
    size: uniformEffectValue(effectEntries, supported, ({ effect }) => effect ? visualEffectSize(effect) : undefined)
  };
}

function uniformEffectValue<T>(
  entries: readonly { effect: VisualEffect | undefined; entry: MoleculeInspectorRingEntry }[],
  supported: readonly boolean[],
  read: (entry: { effect: VisualEffect | undefined; entry: MoleculeInspectorRingEntry }) => T | null | undefined
): ArtInspectorMixedValue<T> {
  const values = entries
    .filter((_, index) => supported[index])
    .map((entry) => read(entry))
    .filter((value): value is T => value !== null && value !== undefined);
  if (values.length === 0) {
    return { value: null, mixed: false };
  }

  const [first, ...rest] = values;
  return {
    value: rest.every((value) => Object.is(value, first)) ? first : null,
    mixed: rest.some((value) => !Object.is(value, first))
  };
}

function ringEffectValue(effects: readonly VisualEffect[]): ArtInspectorEffectValue {
  const effectKinds = [...new Set(effects.map((effect) => effect.kind))];
  if (effectKinds.length === 0) {
    return "none";
  }
  return effectKinds.length === 1 ? effectKinds[0] : "multiple";
}

function moleculeRingStyle(object: MoleculeObject, ringKey: string): Record<string, unknown> {
  const ringStyles = object.style.ringStyles;
  if (!ringStyles || typeof ringStyles !== "object" || Array.isArray(ringStyles)) {
    return {};
  }

  const style = (ringStyles as Record<string, unknown>)[ringKey];
  return style && typeof style === "object" && !Array.isArray(style)
    ? style as Record<string, unknown>
    : {};
}

function moleculeRingFillPaint(object: MoleculeObject, style: Record<string, unknown>): GraphicPaint {
  const paint = graphicPaintFromMetadata(style.fillPaint);
  if (paint) {
    return paint;
  }

  const fillColor = metadataString(style.fillColor);
  if (fillColor) {
    return fillColor.toLowerCase() === "none"
      ? { kind: "none" }
      : { kind: "solid", color: fillColor, opacity: metadataNumber(style.fillOpacity) };
  }

  return moleculeFillPaint(object);
}

function moleculeFillPaint(object: MoleculeObject): GraphicPaint {
  const paint = graphicPaintFromMetadata(object.style.fillPaint);
  if (paint) {
    return paint;
  }

  const fillColor = metadataString(object.style.fillColor);
  return fillColor && fillColor.toLowerCase() !== "none"
    ? { kind: "solid", color: fillColor, opacity: metadataNumber(object.style.fillOpacity) }
    : { kind: "none" };
}

function moleculeRingFillOpacity(
  object: MoleculeObject,
  style: Record<string, unknown>,
  paint: GraphicPaint
): number {
  const explicitOpacity = metadataNumber(style.fillOpacity);
  if (explicitOpacity !== undefined) {
    return clampUnit(explicitOpacity);
  }

  if (paint.kind === "solid" && paint.opacity !== undefined) {
    return clampUnit(paint.opacity);
  }

  return clampUnit(metadataNumber(object.style.fillOpacity) ?? 1);
}

function moleculeFillBaseColor(object: MoleculeObject): string {
  const paint = moleculeFillPaint(object);
  return paint.kind === "solid"
    ? normalizeHexString(paint.color) ?? paint.color
    : DefaultNativeDrawingStyle.bondColor;
}

function graphicPaintFromMetadata(value: unknown): GraphicPaint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const paint = value as Record<string, unknown>;
  if (paint.kind === "none") {
    return { kind: "none" };
  }
  if (paint.kind === "solid") {
    const color = metadataString(paint.color);
    return color
      ? { kind: "solid", color, opacity: metadataNumber(paint.opacity) }
      : undefined;
  }
  return undefined;
}

function visualEffectSize(effect: VisualEffect): number {
  if (effect.kind === "shadow") {
    return clampUnit(Math.max(
      Math.abs(metadataNumber(effect.offsetX) ?? 6),
      Math.abs(metadataNumber(effect.offsetY) ?? 6)
    ) / 24);
  }

  if (effect.kind === "glow") {
    return clampUnit((metadataNumber(effect.blurPx) ?? 7) / 18);
  }

  return clampUnit((metadataNumber(effect.strokeWidth) ?? 1.5) / 4);
}

function metadataString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function metadataNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function fontFacesEqual(first: MoleculeInspectorFontFace, second: MoleculeInspectorFontFace): boolean {
  return first.weight === second.weight && first.style === second.style;
}

/**
 * Would toggling implicit hydrogens change anything the canvas draws? Only labelled atoms carry an
 * H count — `atomDisplayLabel` returns undefined for a plain bonded carbon, so a skeletal structure
 * has nothing to attach hydrogens to until a heteroatom, an isolated atom, or shown terminal
 * carbons puts a label on screen. Decided by diffing the renderer's OWN label function across both
 * settings, so this can never drift from what is actually drawn.
 */
function implicitHydrogensAffectLabels(
  targetObjects: readonly MoleculeObject[],
  atomLabelTargets: readonly MoleculeInspectorAtomLabelTarget[]
): boolean {
  const scopedAtomKeys = atomLabelTargets.length > 0
    ? new Set(atomLabelTargets.map((target) => `${target.objectId} ${target.atomId}`))
    : undefined;

  return targetObjects.some((object) =>
    object.atoms.some((atom) => {
      if (scopedAtomKeys && !scopedAtomKeys.has(`${object.id} ${atom.id}`)) {
        return false;
      }
      const style = nativeMoleculeAtomLabelStyle(object, atom.id);
      const shown = atomDisplayLabel(
        atom,
        object.bonds,
        { ...style, atomLabelHideImplicitHydrogens: false },
        object.atoms
      );
      const hidden = atomDisplayLabel(
        atom,
        object.bonds,
        { ...style, atomLabelHideImplicitHydrogens: true },
        object.atoms
      );
      return shown !== hidden;
    })
  );
}

function nativeMoleculeAtomLabelStyle(object: MoleculeObject, atomId: string) {
  const base = nativeDrawingStyleFromObjectStyle(object.style);
  return {
    ...base,
    atomLabelFontFamily: styleStringMapValue(object.style.atomLabelFontFamilies, atomId) ?? base.atomLabelFontFamily,
    atomLabelFontSizePx: styleNumberMapValue(object.style.atomLabelFontSizes, atomId) ?? base.atomLabelFontSizePx,
    atomLabelFontWeight: styleNumberMapValue(object.style.atomLabelFontWeights, atomId) ?? base.atomLabelFontWeight,
    atomLabelFontStyle: styleFontStyleMapValue(object.style.atomLabelFontStyles, atomId) ?? base.atomLabelFontStyle,
    atomLabelColor: styleStringMapValue(object.style.atomLabelColors, atomId) ?? base.atomLabelColor,
    atomLabelBackgroundColor: styleStringMapValue(object.style.atomLabelBackgroundColors, atomId) ?? base.atomLabelBackgroundColor,
    atomLabelPaddingPx: styleNumberMapValue(object.style.atomLabelPaddings, atomId) ?? base.atomLabelPaddingPx,
    atomLabelBondClearancePx: styleNumberMapValue(object.style.atomLabelBondClearances, atomId) ?? base.atomLabelBondClearancePx,
    atomLabelAlignment: styleAtomLabelAlignmentMapValue(object.style.atomLabelAlignments, atomId) ?? base.atomLabelAlignment,
    atomLabelPlacement: styleAtomLabelPlacementMapValue(object.style.atomLabelPlacements, atomId) ?? base.atomLabelPlacement,
    atomLabelShowTerminalCarbons: styleBooleanMapValue(
      object.style.atomLabelShowTerminalCarbonsByAtomId,
      atomId
    ) ?? base.atomLabelShowTerminalCarbons,
    atomLabelHideImplicitHydrogens: styleBooleanMapValue(
      object.style.atomLabelHideImplicitHydrogensByAtomId,
      atomId
    ) ?? base.atomLabelHideImplicitHydrogens
  };
}

function styleStringMapValue(value: unknown, id: string): string | undefined {
  const entry = styleMapEntry(value, id);
  return typeof entry === "string" ? entry : undefined;
}

function styleNumberMapValue(value: unknown, id: string): number | undefined {
  const entry = styleMapEntry(value, id);
  return typeof entry === "number" && Number.isFinite(entry) ? entry : undefined;
}

function styleBooleanMapValue(value: unknown, id: string): boolean | undefined {
  const entry = styleMapEntry(value, id);
  return typeof entry === "boolean" ? entry : undefined;
}

function styleFontStyleMapValue(value: unknown, id: string): NativeTextFontStyle | undefined {
  const entry = styleStringMapValue(value, id);
  return entry === "normal" || entry === "italic" ? entry : undefined;
}

function styleAtomLabelAlignmentMapValue(value: unknown, id: string): NativeAtomLabelAlignment | undefined {
  const entry = styleStringMapValue(value, id);
  return entry === "automatic" || entry === "left" || entry === "center" || entry === "right"
    ? entry
    : undefined;
}

function styleAtomLabelPlacementMapValue(value: unknown, id: string): NativeAtomLabelPlacement | undefined {
  const entry = styleStringMapValue(value, id);
  return entry === "automatic" || entry === "above" || entry === "below" ? entry : undefined;
}

function styleMapEntry(value: unknown, id: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[id];
}

function normalizeHexString(color: string | undefined): string | undefined {
  const normalized = color?.trim().replace(/^#/, "").toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (/^[0-9a-f]{3}$/.test(normalized)) {
    return `#${normalized.split("").map((character) => `${character}${character}`).join("")}`;
  }
  return /^[0-9a-f]{6}$/.test(normalized) ? `#${normalized}` : undefined;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle];
}
