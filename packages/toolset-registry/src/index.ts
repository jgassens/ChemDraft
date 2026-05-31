import { z } from "zod";

const NonEmptyStringSchema = z.string().trim().min(1);
const CommandIdSchema = NonEmptyStringSchema.regex(
  /^[A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*$/,
  "Command IDs must be non-empty identifiers without whitespace."
);

export const ToolsetSourceSchema = z.enum(["core", "plugin", "user"]);
export const ToolsetModeSchema = z.enum(["floating", "docked", "hidden"]);
export const ToolsetOrientationSchema = z.enum(["vertical", "horizontal"]);

export const ToolsetGridLayoutSchema = z
  .object({
    orientation: ToolsetOrientationSchema.optional(),
    rows: z.number().int().positive().optional(),
    columns: z.number().int().positive().optional(),
    cellWidth: z.number().positive().optional(),
    cellHeight: z.number().positive().optional()
  })
  .strict();

export const ToolsetItemPlacementSchema = z
  .object({
    groupId: NonEmptyStringSchema.optional(),
    row: z.number().int().nonnegative().optional(),
    column: z.number().int().nonnegative().optional(),
    order: z.number().int().nonnegative().optional()
  })
  .strict();

export const ToolsetWindowSizeSchema = z
  .object({
    width: z.number().positive(),
    height: z.number().positive(),
    minWidth: z.number().positive().optional(),
    minHeight: z.number().positive().optional()
  })
  .strict();

export const ToolsetItemSchema = z
  .object({
    commandId: CommandIdSchema,
    title: NonEmptyStringSchema.optional(),
    icon: NonEmptyStringSchema.optional(),
    assetName: NonEmptyStringSchema.optional(),
    shortcutDisplay: z.string().optional(),
    disabledReason: z.string().optional(),
    category: z.string().optional(),
    placement: ToolsetItemPlacementSchema.optional()
  })
  .strict();

export const ToolsetGroupSchema = z
  .object({
    id: NonEmptyStringSchema.optional(),
    title: NonEmptyStringSchema.optional(),
    items: z.array(ToolsetItemSchema).min(1)
  })
  .strict();

export const ToolsetDefinitionSchema = z
  .object({
    id: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    source: ToolsetSourceSchema,
    defaultVisible: z.boolean(),
    defaultMode: ToolsetModeSchema,
    groups: z.array(ToolsetGroupSchema).min(1),
    preferredWindowSize: ToolsetWindowSizeSchema.optional(),
    category: z.string().optional(),
    gridLayout: ToolsetGridLayoutSchema.optional(),
    clonedFromToolsetId: NonEmptyStringSchema.optional()
  })
  .strict();

export const ToolsetItemOverrideSchema = z
  .object({
    commandId: CommandIdSchema,
    hidden: z.boolean().optional(),
    placement: ToolsetItemPlacementSchema.optional()
  })
  .strict();

export const UserToolsetOverrideSchema = z
  .object({
    toolsetId: NonEmptyStringSchema,
    title: NonEmptyStringSchema.optional(),
    visible: z.boolean().optional(),
    mode: ToolsetModeSchema.optional(),
    groupOrder: z.array(NonEmptyStringSchema).optional(),
    itemOrder: z.record(z.array(CommandIdSchema)).optional(),
    hiddenCommandIds: z.array(CommandIdSchema).optional(),
    itemOverrides: z.array(ToolsetItemOverrideSchema).optional(),
    preferredWindowSize: ToolsetWindowSizeSchema.optional(),
    gridLayout: ToolsetGridLayoutSchema.optional()
  })
  .strict();

export const UserToolsetDefinitionSchema = ToolsetDefinitionSchema.extend({
  source: z.literal("user"),
  clonedFromToolsetId: NonEmptyStringSchema.optional()
}).strict();

export const ToolsetLayoutStateSchema = z
  .object({
    version: z.literal(1),
    toolsetOrder: z.array(NonEmptyStringSchema).optional(),
    toolsetOverrides: z.array(UserToolsetOverrideSchema).default([]),
    userToolsets: z.array(UserToolsetDefinitionSchema).default([])
  })
  .strict();

export const ToolsetManifestSchema = z
  .object({
    toolsets: z.array(ToolsetDefinitionSchema).min(1)
  })
  .strict();

export type ToolsetSource = z.infer<typeof ToolsetSourceSchema>;
export type ToolsetMode = z.infer<typeof ToolsetModeSchema>;
export type ToolsetOrientation = z.infer<typeof ToolsetOrientationSchema>;
export type ToolsetGridLayout = z.infer<typeof ToolsetGridLayoutSchema>;
export type ToolsetWindowSize = z.infer<typeof ToolsetWindowSizeSchema>;
export type ToolsetItemPlacement = z.infer<typeof ToolsetItemPlacementSchema>;
export type ToolsetItemOverride = z.infer<typeof ToolsetItemOverrideSchema>;
export type UserToolsetOverride = z.infer<typeof UserToolsetOverrideSchema>;
export type UserToolsetDefinition<TIcon extends string = string, TAssetName extends string = string> =
  Omit<z.infer<typeof UserToolsetDefinitionSchema>, "groups"> & {
    groups: ToolsetGroupDefinition<TIcon, TAssetName>[];
  };
export type ToolsetLayoutState<TIcon extends string = string, TAssetName extends string = string> =
  Omit<z.infer<typeof ToolsetLayoutStateSchema>, "userToolsets"> & {
    userToolsets: UserToolsetDefinition<TIcon, TAssetName>[];
  };

export type ToolsetItemDefinition<TIcon extends string = string, TAssetName extends string = string> =
  Omit<z.infer<typeof ToolsetItemSchema>, "icon" | "assetName"> & {
    icon?: TIcon;
    assetName?: TAssetName;
  };

export type ToolsetGroupDefinition<TIcon extends string = string, TAssetName extends string = string> =
  Omit<z.infer<typeof ToolsetGroupSchema>, "items"> & {
    items: ToolsetItemDefinition<TIcon, TAssetName>[];
  };

export type ToolsetDefinition<TIcon extends string = string, TAssetName extends string = string> =
  Omit<z.infer<typeof ToolsetDefinitionSchema>, "groups"> & {
    groups: ToolsetGroupDefinition<TIcon, TAssetName>[];
  };

export interface ToolbarsMenuItem {
  id: string;
  title: string;
  commandId: string;
  toolsetId: string;
  checked: boolean;
  source: ToolsetSource;
}

export interface ToolsetToggleCommandDefinition {
  id: string;
  title: string;
  source: ToolsetSource;
  category: "view";
  toolsetId: string;
}

export interface ApplyToolsetLayoutStateOptions {
  registeredCommandIds?: ReadonlySet<string> | readonly string[];
}

export class ToolsetRegistry<TIcon extends string = string, TAssetName extends string = string> {
  readonly #toolsets = new Map<string, ToolsetDefinition<TIcon, TAssetName>>();

  constructor(toolsets: ToolsetDefinition<TIcon, TAssetName>[] = []) {
    this.registerMany(toolsets);
  }

  register(toolset: ToolsetDefinition<TIcon, TAssetName>): ToolsetDefinition<TIcon, TAssetName> {
    const parsed = ToolsetDefinitionSchema.parse(toolset) as ToolsetDefinition<TIcon, TAssetName>;
    if (this.#toolsets.has(parsed.id)) {
      throw new Error(`Toolset "${parsed.id}" is already registered.`);
    }

    this.#toolsets.set(parsed.id, parsed);
    return parsed;
  }

  registerMany(toolsets: ToolsetDefinition<TIcon, TAssetName>[]): void {
    toolsets.forEach((toolset) => this.register(toolset));
  }

  get(toolsetId: string): ToolsetDefinition<TIcon, TAssetName> | undefined {
    return this.#toolsets.get(toolsetId);
  }

  require(toolsetId: string): ToolsetDefinition<TIcon, TAssetName> {
    const toolset = this.get(toolsetId);
    if (!toolset) {
      throw new Error(`Toolset "${toolsetId}" is not registered.`);
    }

    return toolset;
  }

  listToolsets(): ToolsetDefinition<TIcon, TAssetName>[] {
    return [...this.#toolsets.values()];
  }

  listDefaultVisibleToolsets(): ToolsetDefinition<TIcon, TAssetName>[] {
    return this.listToolsets().filter((toolset) => toolset.defaultVisible);
  }

  listCommandIds(): string[] {
    return [
      ...new Set(
        this.listToolsets().flatMap((toolset) =>
          toolset.groups.flatMap((group) => group.items.map((item) => item.commandId))
        )
      )
    ];
  }
}

export function parseToolsetManifest<TIcon extends string = string, TAssetName extends string = string>(
  manifest: unknown
): ToolsetDefinition<TIcon, TAssetName>[] {
  return ToolsetManifestSchema.parse(manifest).toolsets as ToolsetDefinition<TIcon, TAssetName>[];
}

export function parseToolsetLayoutState<TIcon extends string = string, TAssetName extends string = string>(
  state: unknown
): ToolsetLayoutState<TIcon, TAssetName> {
  return ToolsetLayoutStateSchema.parse(state) as ToolsetLayoutState<TIcon, TAssetName>;
}

export function applyToolsetLayoutState<TIcon extends string = string, TAssetName extends string = string>(
  toolsets: readonly ToolsetDefinition<TIcon, TAssetName>[],
  state: unknown,
  options: ApplyToolsetLayoutStateOptions = {}
): ToolsetDefinition<TIcon, TAssetName>[] {
  const parsed = parseToolsetLayoutState<TIcon, TAssetName>(state);
  const commandIds = commandIdSetFromOptions(toolsets, options);
  const baseToolsets = toolsets.map(cloneToolset);
  const userToolsets = parsed.userToolsets.map(cloneToolset);
  assertUniqueUserToolsets(baseToolsets, userToolsets);
  userToolsets.forEach((toolset) => assertToolsetCommandsRegistered(toolset, commandIds));

  const toolsetsById = new Map<string, ToolsetDefinition<TIcon, TAssetName>>();
  [...baseToolsets, ...userToolsets].forEach((toolset) => {
    toolsetsById.set(toolset.id, toolset);
  });

  for (const override of parsed.toolsetOverrides) {
    const toolset = toolsetsById.get(override.toolsetId);
    if (!toolset) {
      continue;
    }

    assertOverrideCommandsRegistered(override, commandIds);
    toolsetsById.set(override.toolsetId, applyUserToolsetOverride(toolset, override));
  }

  return orderToolsets([...toolsetsById.values()], parsed.toolsetOrder);
}

export function createToolsetToggleCommandId(toolsetId: string): string {
  return `view.toolset.toggle.${toolsetId}`;
}

export function parseToolsetToggleCommandId(commandId: string): string | undefined {
  const prefix = "view.toolset.toggle.";
  return commandId.startsWith(prefix) ? commandId.slice(prefix.length) : undefined;
}

export function createToolbarsMenuModel(
  toolsets: readonly ToolsetDefinition[],
  visibleToolsetIds: ReadonlySet<string> = new Set(toolsets.filter((toolset) => toolset.defaultVisible).map((toolset) => toolset.id))
): ToolbarsMenuItem[] {
  return toolsets.map((toolset) => ({
    id: `menu.toolbars.${toolset.id}`,
    title: toolset.title,
    commandId: createToolsetToggleCommandId(toolset.id),
    toolsetId: toolset.id,
    checked: visibleToolsetIds.has(toolset.id),
    source: toolset.source
  }));
}

export function createToolsetToggleCommandDefinitions(
  toolsets: readonly ToolsetDefinition[]
): ToolsetToggleCommandDefinition[] {
  return toolsets.map((toolset) => ({
    id: createToolsetToggleCommandId(toolset.id),
    title: `Toggle ${toolset.title}`,
    source: toolset.source,
    category: "view",
    toolsetId: toolset.id
  }));
}

function applyUserToolsetOverride<TIcon extends string, TAssetName extends string>(
  toolset: ToolsetDefinition<TIcon, TAssetName>,
  override: UserToolsetOverride
): ToolsetDefinition<TIcon, TAssetName> {
  const hiddenCommandIds = new Set(override.hiddenCommandIds ?? []);
  const itemOverrides = new Map((override.itemOverrides ?? []).map((itemOverride) => [itemOverride.commandId, itemOverride]));
  itemOverrides.forEach((itemOverride, commandId) => {
    if (itemOverride.hidden === true) {
      hiddenCommandIds.add(commandId);
    }
    if (itemOverride.hidden === false) {
      hiddenCommandIds.delete(commandId);
    }
  });

  const groups = reorderById(toolset.groups, override.groupOrder ?? [], (group) => group.id).map((group) => {
    const orderedItems = reorderById(group.items, group.id ? (override.itemOrder?.[group.id] ?? []) : [], (item) => item.commandId)
      .filter((item) => !hiddenCommandIds.has(item.commandId))
      .map((item) => {
        const placement = itemOverrides.get(item.commandId)?.placement;
        return placement ? { ...item, placement } : item;
      });

    return { ...group, items: orderedItems };
  }).filter((group) => group.items.length > 0);

  return {
    ...toolset,
    title: override.title ?? toolset.title,
    defaultVisible: override.visible ?? toolset.defaultVisible,
    defaultMode: override.mode ?? toolset.defaultMode,
    preferredWindowSize: override.preferredWindowSize ?? toolset.preferredWindowSize,
    gridLayout: override.gridLayout ?? toolset.gridLayout,
    groups
  };
}

function orderToolsets<TIcon extends string, TAssetName extends string>(
  toolsets: ToolsetDefinition<TIcon, TAssetName>[],
  toolsetOrder: readonly string[] = []
): ToolsetDefinition<TIcon, TAssetName>[] {
  return reorderById(toolsets, toolsetOrder, (toolset) => toolset.id);
}

function reorderById<T>(items: readonly T[], preferredOrder: readonly string[], idForItem: (item: T) => string | undefined): T[] {
  if (preferredOrder.length === 0) {
    return [...items];
  }

  const remaining = [...items];
  const ordered: T[] = [];

  for (const id of preferredOrder) {
    const index = remaining.findIndex((item) => idForItem(item) === id);
    if (index >= 0) {
      ordered.push(remaining.splice(index, 1)[0]);
    }
  }

  return [...ordered, ...remaining];
}

function cloneToolset<TIcon extends string, TAssetName extends string>(
  toolset: ToolsetDefinition<TIcon, TAssetName>
): ToolsetDefinition<TIcon, TAssetName> {
  return {
    ...toolset,
    preferredWindowSize: toolset.preferredWindowSize ? { ...toolset.preferredWindowSize } : undefined,
    gridLayout: toolset.gridLayout ? { ...toolset.gridLayout } : undefined,
    groups: toolset.groups.map((group) => ({
      ...group,
      items: group.items.map((item) => ({
        ...item,
        placement: item.placement ? { ...item.placement } : undefined
      }))
    }))
  };
}

function commandIdSetFromOptions<TIcon extends string, TAssetName extends string>(
  toolsets: readonly ToolsetDefinition<TIcon, TAssetName>[],
  options: ApplyToolsetLayoutStateOptions
): ReadonlySet<string> {
  if (options.registeredCommandIds) {
    return "has" in options.registeredCommandIds
      ? options.registeredCommandIds
      : new Set(options.registeredCommandIds);
  }

  return new Set(
    toolsets.flatMap((toolset) => toolset.groups.flatMap((group) => group.items.map((item) => item.commandId)))
  );
}

function assertUniqueUserToolsets<TIcon extends string, TAssetName extends string>(
  baseToolsets: readonly ToolsetDefinition<TIcon, TAssetName>[],
  userToolsets: readonly ToolsetDefinition<TIcon, TAssetName>[]
): void {
  const seen = new Set(baseToolsets.map((toolset) => toolset.id));
  for (const toolset of userToolsets) {
    if (seen.has(toolset.id)) {
      throw new Error(`User toolset "${toolset.id}" duplicates an existing toolset id.`);
    }
    seen.add(toolset.id);
  }
}

function assertToolsetCommandsRegistered<TIcon extends string, TAssetName extends string>(
  toolset: ToolsetDefinition<TIcon, TAssetName>,
  registeredCommandIds: ReadonlySet<string>
): void {
  toolset.groups.forEach((group) => {
    group.items.forEach((item) => assertCommandRegistered(item.commandId, registeredCommandIds));
  });
}

function assertOverrideCommandsRegistered(
  override: UserToolsetOverride,
  registeredCommandIds: ReadonlySet<string>
): void {
  override.hiddenCommandIds?.forEach((commandId) => assertCommandRegistered(commandId, registeredCommandIds));
  override.itemOverrides?.forEach((itemOverride) => assertCommandRegistered(itemOverride.commandId, registeredCommandIds));
  Object.values(override.itemOrder ?? {}).forEach((commandIds) => {
    commandIds.forEach((commandId) => assertCommandRegistered(commandId, registeredCommandIds));
  });
}

function assertCommandRegistered(commandId: string, registeredCommandIds: ReadonlySet<string>): void {
  if (!registeredCommandIds.has(commandId)) {
    throw new Error(`Toolbar customization references unregistered command "${commandId}".`);
  }
}
