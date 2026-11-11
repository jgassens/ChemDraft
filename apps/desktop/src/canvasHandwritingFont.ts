import { useEffect, useMemo, useState } from "react";
import { isPatrickHandFont } from "@chemdraft/layout-engine";

const pending = new WeakMap<FontFaceSet, Promise<boolean>>();

/** The CSS face points only at the bundled same-origin TTF. A rejected/empty load stays sans. */
export function loadCanvasHandwritingFont(fonts: FontFaceSet): Promise<boolean> {
  let result = pending.get(fonts);
  if (!result) {
    result = Promise.resolve().then(() => fonts.load("15px 'Patrick Hand'", "OH"))
      .then(faces => faces.length > 0 && fonts.check("15px 'Patrick Hand'", "OH"))
      .catch(() => false);
    pending.set(fonts, result);
  }
  return result;
}

/** Display-only copy: geometry and drawing both receive the same available font. */
export function canvasFontFallback<T>(value: T): T {
  if (!value || typeof value !== "object" || ArrayBuffer.isView(value)) return value;
  let changed = false;
  const entries = Object.entries(value).map(([key, item]) => {
    const next = (key === "fontFamily" || key === "atomLabelFontFamily") &&
      typeof item === "string" && isPatrickHandFont(item)
      ? "Arial, Helvetica, sans-serif" : canvasFontFallback(item);
    changed ||= next !== item;
    return [key, next];
  });
  return changed ? (Array.isArray(value) ? entries.map(([, item]) => item) : Object.fromEntries(entries)) as T : value;
}

export function useCanvasHandwritingFont<T>(value: T): T {
  const fallback = useMemo(() => canvasFontFallback(value), [value]);
  const [loaded, setLoaded] = useState(false);
  const needed = fallback !== value;
  useEffect(() => {
    if (!needed || !globalThis.document?.fonts) return;
    let cancelled = false;
    void loadCanvasHandwritingFont(globalThis.document.fonts).then(ready => {
      if (!cancelled) setLoaded(ready);
    });
    return () => { cancelled = true; };
  }, [needed]);
  return loaded ? value : fallback;
}
