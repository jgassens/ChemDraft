export const SurfaceKinds = [
  "menu-item",
  "quick-action",
  "status-item",
  "canvas-control",
  "panel-trigger",
  "empty-state"
] as const;

export type SurfaceKind = (typeof SurfaceKinds)[number];

export const SurfaceSources = ["core", "plugin", "user", "owner"] as const;

export type SurfaceSource = (typeof SurfaceSources)[number];

export const SurfaceVisibilities = ["visible", "hidden", "disabled"] as const;

export type SurfaceVisibility = (typeof SurfaceVisibilities)[number];

export interface SurfaceDefinition {
  id: string;
  kind: SurfaceKind;
  source: SurfaceSource;
  slot: string;
  commandId?: string;
  label?: string;
  icon?: string;
  order?: number;
  defaultVisibility: SurfaceVisibility;
  disabledReason?: string;
  featureFlag?: string;
}

const stableIdentifierPattern = /^[A-Za-z0-9._:-]+$/;
const surfaceKindSet = new Set<string>(SurfaceKinds);
const surfaceSourceSet = new Set<string>(SurfaceSources);
const surfaceVisibilitySet = new Set<string>(SurfaceVisibilities);

export function parseSurfaceDefinitions(input: unknown): SurfaceDefinition[] {
  if (!Array.isArray(input)) {
    throw new Error("Surface definitions must be an array.");
  }

  const surfaces = input.map((surface, index) => parseSurfaceDefinition(surface, index));
  assertUniqueSurfaceIds(surfaces);
  return surfaces;
}

export function listSurfacesBySlot(
  surfaces: readonly SurfaceDefinition[],
  slot: string
): SurfaceDefinition[] {
  assertNonEmptyString(slot, "slot");
  return sortSurfaces(surfaces.filter((surface) => surface.slot === slot));
}

export function sortSurfaces(surfaces: readonly SurfaceDefinition[]): SurfaceDefinition[] {
  return [...surfaces].sort((a, b) => {
    const orderComparison = (a.order ?? 0) - (b.order ?? 0);
    if (orderComparison !== 0) {
      return orderComparison;
    }

    return a.id.localeCompare(b.id);
  });
}

export function collectSurfaceCommandIds(surfaces: readonly SurfaceDefinition[]): string[] {
  const commandIds = new Set<string>();

  surfaces.forEach((surface) => {
    if (surface.commandId) {
      commandIds.add(surface.commandId);
    }
  });

  return [...commandIds];
}

export function assertUniqueSurfaceIds(surfaces: readonly SurfaceDefinition[]): void {
  const seen = new Set<string>();

  surfaces.forEach((surface) => {
    if (seen.has(surface.id)) {
      throw new Error(`Duplicate surface id "${surface.id}".`);
    }

    seen.add(surface.id);
  });
}

export function filterVisibleSurfaces(surfaces: readonly SurfaceDefinition[]): SurfaceDefinition[] {
  return surfaces.filter((surface) => surface.defaultVisibility === "visible");
}

function parseSurfaceDefinition(input: unknown, index: number): SurfaceDefinition {
  if (!isRecord(input)) {
    throw new Error(`Surface definition at index ${index} must be an object.`);
  }

  const id = parseStableIdentifier(input.id, "id", index);
  const kind = parseEnumValue(input.kind, surfaceKindSet, "kind", index) as SurfaceKind;
  const source = parseEnumValue(input.source, surfaceSourceSet, "source", index) as SurfaceSource;
  const slot = parseStableIdentifier(input.slot, "slot", index);
  const defaultVisibility = parseEnumValue(
    input.defaultVisibility,
    surfaceVisibilitySet,
    "defaultVisibility",
    index
  ) as SurfaceVisibility;
  const commandId = parseOptionalStableIdentifier(input.commandId, "commandId", index);
  const label = parseOptionalString(input.label, "label", index);
  const icon = parseOptionalStableIdentifier(input.icon, "icon", index);
  const order = parseOptionalOrder(input.order, index);
  const disabledReason = parseOptionalString(input.disabledReason, "disabledReason", index);
  const featureFlag = parseOptionalStableIdentifier(input.featureFlag, "featureFlag", index);

  return {
    id,
    kind,
    source,
    slot,
    ...(commandId === undefined ? {} : { commandId }),
    ...(label === undefined ? {} : { label }),
    ...(icon === undefined ? {} : { icon }),
    ...(order === undefined ? {} : { order }),
    defaultVisibility,
    ...(disabledReason === undefined ? {} : { disabledReason }),
    ...(featureFlag === undefined ? {} : { featureFlag })
  };
}

function parseStableIdentifier(input: unknown, field: string, index: number): string {
  assertNonEmptyString(input, `surface[${index}].${field}`);
  if (!stableIdentifierPattern.test(input)) {
    throw new Error(`surface[${index}].${field} must be a stable identifier without whitespace.`);
  }

  return input;
}

function parseOptionalStableIdentifier(input: unknown, field: string, index: number): string | undefined {
  if (input === undefined) {
    return undefined;
  }

  return parseStableIdentifier(input, field, index);
}

function parseOptionalString(input: unknown, field: string, index: number): string | undefined {
  if (input === undefined) {
    return undefined;
  }

  assertNonEmptyString(input, `surface[${index}].${field}`);
  return input;
}

function parseOptionalOrder(input: unknown, index: number): number | undefined {
  if (input === undefined) {
    return undefined;
  }

  if (typeof input !== "number" || !Number.isFinite(input)) {
    throw new Error(`surface[${index}].order must be a finite number.`);
  }

  return input;
}

function parseEnumValue(input: unknown, allowedValues: ReadonlySet<string>, field: string, index: number): string {
  assertNonEmptyString(input, `surface[${index}].${field}`);
  if (!allowedValues.has(input)) {
    throw new Error(`surface[${index}].${field} has unsupported value "${input}".`);
  }

  return input;
}

function assertNonEmptyString(input: unknown, field: string): asserts input is string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error(`${field} must be a non-empty string.`);
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
