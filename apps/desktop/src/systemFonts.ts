import { isDesktopRuntime } from "./window-manager";

export type SystemFontStyle = "normal" | "italic";

export interface SystemFontFace {
  weight: number;
  style: SystemFontStyle;
}

export interface SystemFontFamily {
  family: string;
  faces: SystemFontFace[];
}

let cachedSystemFonts: Promise<SystemFontFamily[]> | undefined;

export function loadSystemFonts(extraFamilies: readonly string[] = []): Promise<SystemFontFamily[]> {
  if (!cachedSystemFonts) {
    cachedSystemFonts = isDesktopRuntime()
      ? invokeSystemFontCatalog().catch(() => fallbackSystemFonts())
      : Promise.resolve(fallbackSystemFonts());
  }

  return cachedSystemFonts.then((families) => mergeExtraFamilies(families, extraFamilies));
}

async function invokeSystemFontCatalog(): Promise<SystemFontFamily[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  const response = await invoke<unknown>("list_system_fonts");
  return normalizeSystemFonts(response);
}

function normalizeSystemFonts(value: unknown): SystemFontFamily[] {
  if (!Array.isArray(value)) {
    return fallbackSystemFonts();
  }

  const families = value.flatMap((entry): SystemFontFamily[] => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const candidate = entry as Partial<SystemFontFamily>;
    const family = normalizeFamily(candidate.family);
    if (!family || !Array.isArray(candidate.faces)) {
      return [];
    }
    const faces = normalizeFaces(candidate.faces);
    return faces.length > 0 ? [{ family, faces }] : [];
  });

  return mergeExtraFamilies(families, []);
}

function mergeExtraFamilies(
  families: readonly SystemFontFamily[],
  extraFamilies: readonly string[]
): SystemFontFamily[] {
  const byFamily = new Map<string, SystemFontFamily>();
  for (const family of [...fallbackSystemFonts(), ...families]) {
    const name = normalizeFamily(family.family);
    if (!name) {
      continue;
    }
    const current = byFamily.get(name);
    byFamily.set(name, {
      family: name,
      faces: mergeFaces(current?.faces ?? [], normalizeFaces(family.faces))
    });
  }
  for (const family of extraFamilies) {
    const name = normalizeFamily(family);
    if (!name || byFamily.has(name)) {
      continue;
    }
    byFamily.set(name, { family: name, faces: defaultFaces() });
  }

  return [...byFamily.values()].sort((left, right) => left.family.localeCompare(right.family));
}

function normalizeFamily(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const family = value.trim();
  return family.length > 0 && family.length <= 256 && !/[\u0000-\u001f\u007f]/.test(family)
    ? family
    : undefined;
}

function normalizeFaces(values: readonly unknown[]): SystemFontFace[] {
  return mergeFaces([], values.flatMap((face): SystemFontFace[] => {
    if (typeof face !== "object" || face === null) {
      return [];
    }
    const candidate = face as Partial<SystemFontFace>;
    const weight = Number(candidate.weight);
    const style = candidate.style === "italic" ? "italic" : candidate.style === "normal" ? "normal" : undefined;
    return Number.isInteger(weight) && weight >= 1 && weight <= 1000 && style
      ? [{ weight, style }]
      : [];
  }));
}

function mergeFaces(
  first: readonly SystemFontFace[],
  second: readonly SystemFontFace[]
): SystemFontFace[] {
  const keys = new Set<string>();
  const faces = [...first, ...second].flatMap((face): SystemFontFace[] => {
    const key = `${face.weight}:${face.style}`;
    if (keys.has(key)) {
      return [];
    }
    keys.add(key);
    return [face];
  });
  return faces.sort((left, right) => left.weight - right.weight || left.style.localeCompare(right.style));
}

function fallbackSystemFonts(): SystemFontFamily[] {
  return ["Arial", "Helvetica", "Times New Roman", "Courier New", "sans-serif", "serif", "monospace"]
    .map((family) => ({ family, faces: defaultFaces() }));
}

function defaultFaces(): SystemFontFace[] {
  return [
    { weight: 400, style: "normal" },
    { weight: 400, style: "italic" },
    { weight: 700, style: "normal" },
    { weight: 700, style: "italic" }
  ];
}
