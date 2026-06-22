import { visualEffectsForStyle } from "@chemdraft/art-engine";
import type { ChemDraftDocument, GraphicPaint, MoleculeObject, VisualEffect } from "@chemdraft/chem-core";
import { nativeMoleculeRings } from "@chemdraft/layout-engine";
import type {
  ArtInspectorEffectKind,
  ArtInspectorEffectModel,
  ArtInspectorEffectValue,
  ArtInspectorMixedValue
} from "./artInspectorModel";

export interface MoleculeInspectorRingSelection {
  objectId: string;
  kind: "ring";
  ringKey: string;
  atomIds: readonly string[];
  bondIds: readonly string[];
}

export interface MoleculeInspectorModel {
  selectedCount: number;
  selectedRing?: MoleculeInspectorRingSelection;
  selectedRings: MoleculeInspectorRingSelection[];
  effectKinds: ArtInspectorEffectKind[];
  values: {
    fillPaintType: ArtInspectorMixedValue<"none" | "solid">;
    fillColor: ArtInspectorMixedValue<string>;
    fillOpacity: ArtInspectorMixedValue<number>;
    effect: ArtInspectorMixedValue<ArtInspectorEffectValue>;
  };
  effectControls: Record<ArtInspectorEffectKind, ArtInspectorEffectModel>;
}

export function createMoleculeInspectorModel(
  document: ChemDraftDocument,
  selectedPart?: {
    objectId: string;
    kind: string;
    ringKey?: string;
    rings?: readonly { ringKey: string }[];
  }
): MoleculeInspectorModel {
  const empty = emptyMoleculeInspectorModel();
  const selectedRingKeys = selectedRingKeysForPart(selectedPart);
  if (selectedRingKeys.length === 0 || !selectedPart) {
    return empty;
  }

  const object = document.pages
    .flatMap((page) => page.objects)
    .find((candidate): candidate is MoleculeObject =>
      candidate.type === "molecule" && candidate.id === selectedPart.objectId
    );
  if (!object) {
    return empty;
  }

  const moleculeRings = nativeMoleculeRings(object);
  const selectedRings = selectedRingKeys.flatMap((ringKey) => {
    const ring = moleculeRings.find((candidate) => candidate.ringKey === ringKey);
    return ring ? [ring] : [];
  });
  if (selectedRings.length === 0) {
    return empty;
  }

  const entries = selectedRings.map((ring) => {
    const style = moleculeRingStyle(object, ring.ringKey);
    return {
      ring,
      style,
      fillPaint: moleculeRingFillPaint(object, style),
      effects: visualEffectsForStyle(style)
    };
  });
  const effectControls = {
    shadow: effectModelForKind(entries, "shadow"),
    glow: effectModelForKind(entries, "glow"),
    sketch: effectModelForKind(entries, "sketch")
  } satisfies Record<ArtInspectorEffectKind, ArtInspectorEffectModel>;
  const effectKinds = (["shadow", "glow", "sketch"] as const).filter((kind) => effectControls[kind].presentCount > 0);
  const ringSelections = selectedRings.map((ring) => ({
    objectId: object.id,
    kind: "ring" as const,
    ringKey: ring.ringKey,
    atomIds: ring.atomIds,
    bondIds: ring.bondIds
  }));

  return {
    selectedCount: ringSelections.length,
    selectedRing: ringSelections[0],
    selectedRings: ringSelections,
    effectKinds,
    values: {
      fillPaintType: uniformRingValue(entries, (entry) => entry.fillPaint.kind === "none" ? "none" : "solid"),
      fillColor: uniformRingValue(entries, (entry) => entry.fillPaint.kind === "solid"
        ? entry.fillPaint.color
        : moleculeFillBaseColor(object)),
      fillOpacity: uniformRingValue(entries, (entry) => moleculeRingFillOpacity(object, entry.style, entry.fillPaint)),
      effect: uniformRingValue(entries, (entry) => ringEffectValue(entry.effects))
    },
    effectControls
  };
}

function emptyMoleculeInspectorModel(): MoleculeInspectorModel {
  return {
    selectedCount: 0,
    selectedRings: [],
    effectKinds: [],
    values: {
      fillPaintType: { value: "solid", mixed: false },
      fillColor: { value: "#111111", mixed: false },
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

type MoleculeInspectorRingEntry = {
  ring: ReturnType<typeof nativeMoleculeRings>[number];
  style: Record<string, unknown>;
  fillPaint: GraphicPaint;
  effects: readonly VisualEffect[];
};

function selectedRingKeysForPart(
  selectedPart?: {
    kind: string;
    ringKey?: string;
    rings?: readonly { ringKey: string }[];
  }
): string[] {
  if (selectedPart?.kind === "ring" && selectedPart.ringKey) {
    return [selectedPart.ringKey];
  }

  if (selectedPart?.kind !== "rings") {
    return [];
  }

  const seen = new Set<string>();
  return (selectedPart.rings ?? [])
    .map((ring) => ring.ringKey)
    .filter((ringKey) => {
      if (seen.has(ringKey)) {
        return false;
      }
      seen.add(ringKey);
      return true;
    });
}

function uniformRingValue<T>(
  entries: readonly MoleculeInspectorRingEntry[],
  read: (entry: MoleculeInspectorRingEntry) => T | null | undefined
): ArtInspectorMixedValue<T> {
  const values = entries
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
    ? paint.color
    : "#111111";
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
