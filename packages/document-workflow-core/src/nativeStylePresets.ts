import {
  NativeStylePresets, SketchStylePreset, nativeDrawingStyleFromObjectStyle, nativeTextStyleFromObjectStyle, stylePresetToObjectStyle,
  type ChemDraftDocument, type DocumentObject, type DocumentPatch
} from "@chemdraft/chem-core";
import { moleculeTargetBondLengthChanges } from "./molecule";

export type NativeStylePresetScope = "selection" | "document";

/**
 * Plan one atomic style edit. An empty batch means nothing changed; callers skip applying it.
 * Each molecule keeps its centre and chemical graph. Other object kinds are untouched.
 * The selected page can select its changed objects; changes on other pages remain on those pages.
 */
export function applyNativeStylePreset(
  document: ChemDraftDocument, presetId: string, scope: NativeStylePresetScope
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
    for (const object of currentPage.objects) {
      if (scope === "selection" && (currentPage.id !== page.id || !selected.has(object.id))) continue;
      let changes: Partial<DocumentObject>;
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
        changes = {
          ...moleculeTargetBondLengthChanges(object, preset.drawing.bondLengthPx),
          style
        };
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
