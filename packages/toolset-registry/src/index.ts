import { z } from "zod";

const NonEmptyStringSchema = z.string().trim().min(1);
const CommandIdSchema = NonEmptyStringSchema.regex(
  /^[A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*$/,
  "Command IDs must be non-empty identifiers without whitespace."
);
const IconDataUriSchema = z
  .string()
  .regex(/^data:image\/(png|svg\+xml);base64,/, "Toolset icons must be base64 png or svg+xml data URIs.")
  .max(64_000);

export const ToolsetSourceSchema = z.enum(["core", "plugin", "user"]);
export const ToolsetModeSchema = z.enum(["floating", "docked", "hidden"]);
export const ToolsetOrientationSchema = z.enum(["vertical", "horizontal"]);

export const ToolsetGridLayoutSchema = z
  .object({
    orientation: ToolsetOrientationSchema.optional(),
    rows: z.number().int().positive().optional(),
    columns: z.number().int().positive().optional(),
    cellWidth: z.number().positive().optional(),
    cellHeight: z.number().positive().optional(),
    gap: z.number().int().nonnegative().optional(),
    padding: z.number().int().nonnegative().optional()
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

export const ToolsetItemKindSchema = z.enum(["button", "toggle", "control", "separator"]);

export const ToolsetPrimaryActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command"), commandId: CommandIdSchema }).strict(),
  z.object({ type: z.literal("control"), controlId: NonEmptyStringSchema }).strict(),
  z.object({ type: z.literal("none") }).strict()
]);

export const ToolsetTooltipSchema = z
  .object({
    title: NonEmptyStringSchema.optional(),
    description: z.string().nullable().optional(),
    shortcut: z.string().nullable().optional()
  })
  .strict();

export const ToolsetSubmenuItemSchema = z
  .object({
    commandId: CommandIdSchema,
    label: NonEmptyStringSchema.optional(),
    title: NonEmptyStringSchema.optional(),
    icon: NonEmptyStringSchema.optional(),
    assetName: NonEmptyStringSchema.optional(),
    iconDataUri: IconDataUriSchema.optional(),
    tooltip: ToolsetTooltipSchema.optional()
  })
  .strict();

export const ToolsetSubmenuSchema = z
  .object({
    type: z.literal("command-grid"),
    id: NonEmptyStringSchema.optional(),
    title: NonEmptyStringSchema.optional(),
    columns: z.number().int().positive().optional(),
    items: z.array(ToolsetSubmenuItemSchema).min(1)
  })
  .strict();

export const ToolsetItemLayoutSchema = z
  .object({
    colSpan: z.number().int().positive().optional(),
    rowSpan: z.number().int().positive().optional()
  })
  .strict();

export const ToolsetItemSchema = z
  .object({
    commandId: CommandIdSchema.optional(),
    id: NonEmptyStringSchema.optional(),
    kind: ToolsetItemKindSchema.optional(),
    label: NonEmptyStringSchema.optional(),
    title: NonEmptyStringSchema.optional(),
    icon: NonEmptyStringSchema.optional(),
    assetName: NonEmptyStringSchema.optional(),
    /** Inline icon for contributions that cannot ship named assets (plugins). */
    iconDataUri: IconDataUriSchema.optional(),
    shortcutDisplay: z.string().optional(),
    disabledReason: z.string().optional(),
    category: z.string().optional(),
    placement: ToolsetItemPlacementSchema.optional(),
    primary: ToolsetPrimaryActionSchema.optional(),
    submenu: ToolsetSubmenuSchema.nullish(),
    tooltip: ToolsetTooltipSchema.optional(),
    layout: ToolsetItemLayoutSchema.optional()
  })
  .strict()
  .superRefine((item, context) => {
    if (item.primary === undefined && item.commandId === undefined && item.kind !== "separator") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Toolset items require commandId, primary, or separator kind."
      });
    }
    if (item.primary?.type === "command" && item.commandId !== undefined && item.primary.commandId !== item.commandId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Toolset item commandId must match primary.commandId."
      });
    }
  });

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
    placement: ToolsetItemPlacementSchema.optional(),
    layout: ToolsetItemLayoutSchema.optional()
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
export type ToolsetItemKind = z.infer<typeof ToolsetItemKindSchema>;
export type ToolsetPrimaryAction = z.infer<typeof ToolsetPrimaryActionSchema>;
export type ToolsetTooltip = z.infer<typeof ToolsetTooltipSchema>;
export type ToolsetItemLayout = z.infer<typeof ToolsetItemLayoutSchema>;
export type ToolsetItemOverride = z.infer<typeof ToolsetItemOverrideSchema>;
export type UserToolsetOverride = z.infer<typeof UserToolsetOverrideSchema>;
export type ToolsetSubmenuItem<TIcon extends string = string, TAssetName extends string = string> =
  Omit<z.infer<typeof ToolsetSubmenuItemSchema>, "icon" | "assetName"> & {
    icon?: TIcon;
    assetName?: TAssetName;
  };
export type ToolsetSubmenu<TIcon extends string = string, TAssetName extends string = string> =
  Omit<z.infer<typeof ToolsetSubmenuSchema>, "items"> & {
    items: ToolsetSubmenuItem<TIcon, TAssetName>[];
  };
export type UserToolsetDefinition<TIcon extends string = string, TAssetName extends string = string> =
  Omit<z.infer<typeof UserToolsetDefinitionSchema>, "groups"> & {
    groups: ToolsetGroupDefinition<TIcon, TAssetName>[];
  };
export type ToolsetLayoutState<TIcon extends string = string, TAssetName extends string = string> =
  Omit<z.infer<typeof ToolsetLayoutStateSchema>, "userToolsets"> & {
    userToolsets: UserToolsetDefinition<TIcon, TAssetName>[];
  };

export type ToolsetItemDefinition<TIcon extends string = string, TAssetName extends string = string> =
  Omit<z.infer<typeof ToolsetItemSchema>, "icon" | "assetName" | "submenu"> & {
    icon?: TIcon;
    assetName?: TAssetName;
    submenu?: ToolsetSubmenu<TIcon, TAssetName> | null;
  };

export type ToolsetGroupDefinition<TIcon extends string = string, TAssetName extends string = string> =
  Omit<z.infer<typeof ToolsetGroupSchema>, "items"> & {
    items: ToolsetItemDefinition<TIcon, TAssetName>[];
  };

export type ToolsetDefinition<TIcon extends string = string, TAssetName extends string = string> =
  Omit<z.infer<typeof ToolsetDefinitionSchema>, "groups"> & {
    groups: ToolsetGroupDefinition<TIcon, TAssetName>[];
  };

export interface NormalizedToolsetSubmenuItem {
  commandId: string;
  label: string;
  icon?: string;
  assetName?: string;
  iconDataUri?: string;
  tooltip?: {
    title?: string;
    description?: string | null;
    shortcut?: string | null;
  };
}

export interface NormalizedToolsetItem {
  id: string;
  kind: ToolsetItemKind;
  label: string;
  icon?: string;
  assetName?: string;
  iconDataUri?: string;
  primary: ToolsetPrimaryAction;
  submenu: {
    type: "command-grid";
    id?: string;
    title?: string;
    columns?: number;
    items: NormalizedToolsetSubmenuItem[];
  } | null;
  tooltip: {
    title: string;
    description?: string | null;
    shortcut?: string | null;
  };
  layout: {
    groupId?: string;
    row?: number;
    column?: number;
    order?: number;
    colSpan: number;
    rowSpan: number;
  };
  commandId?: string;
  title?: string;
  shortcutDisplay?: string;
  disabledReason?: string;
  category?: string;
}

export interface NormalizedToolsetGroup {
  id?: string;
  title?: string;
  items: NormalizedToolsetItem[];
}

export type NormalizedToolsetDefinition = Omit<ToolsetDefinition, "groups"> & {
  groups: NormalizedToolsetGroup[];
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
  /** "throw" (default) rejects layout state referencing unknown commands; "prune" drops the
   *  offending items/overrides instead — persisted customization must never crash startup
   *  just because a plugin was removed — and reports each drop through onWarning. */
  onUnknownCommand?: "throw" | "prune";
  onWarning?: (warning: string) => void;
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
    return [...new Set(this.listToolsets().flatMap(toolsetCommandIds))];
  }
}

export function parseToolsetManifest<TIcon extends string = string, TAssetName extends string = string>(
  manifest: unknown
): ToolsetDefinition<TIcon, TAssetName>[] {
  return ToolsetManifestSchema.parse(manifest).toolsets as ToolsetDefinition<TIcon, TAssetName>[];
}

export interface NormalizeToolsetItemContext {
  toolsetId?: string;
  groupId?: string;
  itemIndex?: number;
}

export function normalizeToolsetItem<TIcon extends string = string, TAssetName extends string = string>(
  item: ToolsetItemDefinition<TIcon, TAssetName>,
  context: NormalizeToolsetItemContext = {}
): NormalizedToolsetItem {
  if (item.primary?.type === "command" && item.commandId && item.primary.commandId !== item.commandId) {
    throw new Error(
      `Toolset item "${item.id ?? item.commandId}" declares commandId "${item.commandId}" but primary command "${item.primary.commandId}".`
    );
  }

  const primary: ToolsetPrimaryAction = item.primary ?? (item.commandId
    ? { type: "command", commandId: item.commandId }
    : { type: "none" });
  const id = item.id
    ?? item.commandId
    ?? (primary.type === "control" ? primary.controlId : undefined)
    // A separator has no command/control id, so synthesize a stable one from its position. Never
    // require context.groupId here — a schema-valid separator in an id-less group must not crash.
    ?? (primary.type === "none"
      ? `${context.toolsetId ?? "toolset"}.${context.groupId ?? "group"}.separator.${context.itemIndex ?? 0}`
      : undefined);
  if (!id) {
    throw new Error("Toolset item requires an id, commandId, or a control/separator primary.");
  }

  const kind: ToolsetItemKind = item.kind
    ?? (item.commandId || primary.type === "command"
      ? "button"
      : primary.type === "control"
        ? "control"
        : primary.type === "none"
          ? "separator"
          : "button");
  const label = item.label ?? item.title ?? item.commandId ?? id;

  return {
    id,
    kind,
    label,
    icon: item.icon,
    assetName: item.assetName,
    iconDataUri: item.iconDataUri,
    primary,
    submenu: normalizeToolsetSubmenu(item.submenu ?? null),
    tooltip: {
      title: item.tooltip?.title ?? label ?? item.title ?? item.commandId ?? id,
      description: item.tooltip && "description" in item.tooltip ? item.tooltip.description ?? null : null,
      shortcut: item.tooltip && "shortcut" in item.tooltip ? item.tooltip.shortcut ?? null : item.shortcutDisplay ?? null
    },
    layout: {
      groupId: item.placement?.groupId,
      row: item.placement?.row,
      column: item.placement?.column,
      order: item.placement?.order,
      colSpan: item.layout?.colSpan ?? 1,
      rowSpan: item.layout?.rowSpan ?? 1
    },
    commandId: item.commandId,
    title: item.title,
    shortcutDisplay: item.shortcutDisplay,
    disabledReason: item.disabledReason,
    category: item.category
  };
}

export function normalizeToolsetGroup<TIcon extends string = string, TAssetName extends string = string>(
  group: ToolsetGroupDefinition<TIcon, TAssetName>,
  context: Omit<NormalizeToolsetItemContext, "itemIndex"> = {}
): NormalizedToolsetGroup {
  return {
    id: group.id,
    title: group.title,
    items: group.items.map((item, itemIndex) =>
      normalizeToolsetItem(item, { ...context, groupId: group.id ?? context.groupId, itemIndex })
    )
  };
}

export function normalizeToolsetDefinition<TIcon extends string = string, TAssetName extends string = string>(
  toolset: ToolsetDefinition<TIcon, TAssetName>
): NormalizedToolsetDefinition {
  return {
    ...toolset,
    groups: toolset.groups.map((group, groupIndex) =>
      normalizeToolsetGroup(group, { toolsetId: toolset.id, groupId: group.id ?? `group-${groupIndex}` })
    )
  };
}

export function normalizeToolsetDefinitions<TIcon extends string = string, TAssetName extends string = string>(
  toolsets: readonly ToolsetDefinition<TIcon, TAssetName>[]
): NormalizedToolsetDefinition[] {
  return toolsets.map(normalizeToolsetDefinition);
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
  const onUnknownCommand = options.onUnknownCommand ?? "throw";
  const warn = options.onWarning ?? (() => undefined);
  const baseToolsets = toolsets.map(cloneToolset);
  const userToolsets = parsed.userToolsets
    .map(cloneToolset)
    .map((toolset) => {
      if (onUnknownCommand === "prune") {
        return pruneUnknownToolsetCommands(toolset, commandIds, warn);
      }
      assertToolsetCommandsRegistered(toolset, commandIds);
      return toolset;
    })
    .filter((toolset): toolset is ToolsetDefinition<TIcon, TAssetName> => toolset !== undefined);
  assertUniqueUserToolsets(baseToolsets, userToolsets);

  const toolsetsById = new Map<string, ToolsetDefinition<TIcon, TAssetName>>();
  [...baseToolsets, ...userToolsets].forEach((toolset) => {
    toolsetsById.set(toolset.id, toolset);
  });

  for (const override of parsed.toolsetOverrides) {
    const toolset = toolsetsById.get(override.toolsetId);
    if (!toolset) {
      continue;
    }

    let safeOverride = override;
    if (onUnknownCommand === "prune") {
      safeOverride = pruneUnknownOverrideCommands(override, commandIds, warn);
    } else {
      assertOverrideCommandsRegistered(override, commandIds);
    }
    toolsetsById.set(override.toolsetId, applyUserToolsetOverride(toolset, safeOverride));
  }

  return orderToolsets([...toolsetsById.values()], parsed.toolsetOrder);
}

function pruneUnknownToolsetCommands<TIcon extends string, TAssetName extends string>(
  toolset: ToolsetDefinition<TIcon, TAssetName>,
  registeredCommandIds: ReadonlySet<string>,
  warn: (warning: string) => void
): ToolsetDefinition<TIcon, TAssetName> | undefined {
	const groups = toolset.groups
	  .map((group) => ({
	    ...group,
	    items: group.items.flatMap((item) => {
	      const unknownPrimaryIds = toolsetItemPrimaryCommandIds(item).filter(
	        (commandId) => !registeredCommandIds.has(commandId)
	      );
	      if (unknownPrimaryIds.length > 0) {
	        // The item's own command is gone — drop the whole item.
	        unknownPrimaryIds.forEach((commandId) => {
	          warn(`User toolset "${toolset.id}" dropped unknown command "${commandId}".`);
	        });
	        return [];
	      }
	      // Primary is registered — keep the button and prune only unknown submenu entries.
	      const submenu = pruneUnknownSubmenuCommands(toolset.id, item, registeredCommandIds, warn);
	      return [{ ...item, submenu }];
	    })
	  }))
    .filter((group) => group.items.length > 0);

  if (groups.length === 0) {
    warn(`User toolset "${toolset.id}" was dropped: none of its commands are registered.`);
    return undefined;
  }

  return { ...toolset, groups };
}

function pruneUnknownSubmenuCommands<TIcon extends string, TAssetName extends string>(
  toolsetId: string,
  item: ToolsetItemDefinition<TIcon, TAssetName>,
  registeredCommandIds: ReadonlySet<string>,
  warn: (warning: string) => void
): ToolsetSubmenu<TIcon, TAssetName> | null | undefined {
  if (!item.submenu) {
    return item.submenu;
  }

  const items = item.submenu.items.filter((submenuItem) => {
    if (registeredCommandIds.has(submenuItem.commandId)) {
      return true;
    }
    warn(`User toolset "${toolsetId}" dropped unknown submenu command "${submenuItem.commandId}".`);
    return false;
  });

  return items.length > 0 ? { ...item.submenu, items } : null;
}

function pruneUnknownOverrideCommands(
  override: UserToolsetOverride,
  registeredCommandIds: ReadonlySet<string>,
  warn: (warning: string) => void
): UserToolsetOverride {
  const keep = (commandId: string, context: string): boolean => {
    if (registeredCommandIds.has(commandId)) {
      return true;
    }
    warn(`Toolbar customization for "${override.toolsetId}" dropped unknown command "${commandId}" (${context}).`);
    return false;
  };

  return {
    ...override,
    hiddenCommandIds: override.hiddenCommandIds?.filter((commandId) => keep(commandId, "hidden command")),
    itemOverrides: override.itemOverrides?.filter((itemOverride) => keep(itemOverride.commandId, "item override")),
    itemOrder: override.itemOrder
      ? Object.fromEntries(
          Object.entries(override.itemOrder).map(([groupId, commandIdList]) => [
            groupId,
            commandIdList.filter((commandId) => keep(commandId, "item order"))
          ])
        )
      : undefined
  };
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
    const orderedItems = reorderById(group.items, group.id ? (override.itemOrder?.[group.id] ?? []) : [], toolsetItemCustomizationId)
      .filter((item) => {
        const commandId = toolsetItemCustomizationId(item);
        return commandId === undefined || !hiddenCommandIds.has(commandId);
      })
      .map((item) => {
        const commandId = toolsetItemCustomizationId(item);
        const itemOverride = commandId === undefined ? undefined : itemOverrides.get(commandId);
        if (!itemOverride) {
          return item;
        }
        return {
          ...item,
          placement: itemOverride.placement ?? item.placement,
          layout: itemOverride.layout ? { ...item.layout, ...itemOverride.layout } : item.layout
        };
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
        placement: item.placement ? { ...item.placement } : undefined,
        primary: item.primary ? { ...item.primary } : undefined,
        submenu: item.submenu
          ? {
              ...item.submenu,
              items: item.submenu.items.map((submenuItem) => ({
                ...submenuItem,
                tooltip: submenuItem.tooltip ? { ...submenuItem.tooltip } : undefined
              }))
            }
          : item.submenu,
        tooltip: item.tooltip ? { ...item.tooltip } : undefined,
        layout: item.layout ? { ...item.layout } : undefined
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

  return new Set(toolsets.flatMap(toolsetOverrideTargetIds));
}

/** Ids an override may legitimately target: command ids PLUS `control` (widget) ids, since widgets
 *  are customizable (hide/reorder) by their controlId. Kept separate from {@link toolsetCommandIds}
 *  so the public `commandIds()` surface stays commands-only. */
function toolsetOverrideTargetIds<TIcon extends string, TAssetName extends string>(
  toolset: ToolsetDefinition<TIcon, TAssetName>
): string[] {
  return toolset.groups.flatMap((group) =>
    group.items.flatMap((item) => {
      const ids = toolsetItemCommandIds(item);
      if (item.primary?.type === "control") {
        ids.push(item.primary.controlId);
      }
      return ids;
    })
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
    group.items.forEach((item) => {
      toolsetItemCommandIds(item).forEach((commandId) => assertCommandRegistered(commandId, registeredCommandIds));
    });
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

function normalizeToolsetSubmenu<TIcon extends string = string, TAssetName extends string = string>(
  submenu: ToolsetSubmenu<TIcon, TAssetName> | null | undefined
): NormalizedToolsetItem["submenu"] {
  if (!submenu) {
    return null;
  }

  return {
    type: submenu.type,
    id: submenu.id,
    title: submenu.title,
    columns: submenu.columns,
    items: submenu.items.map((item) => {
      const label = item.label ?? item.title ?? item.commandId;
      return {
        commandId: item.commandId,
        label,
        icon: item.icon,
        assetName: item.assetName,
        iconDataUri: item.iconDataUri,
        tooltip: item.tooltip
          ? {
              title: item.tooltip.title ?? label,
              description: item.tooltip.description ?? null,
              shortcut: item.tooltip.shortcut ?? null
            }
          : undefined
      };
    })
  };
}

function toolsetCommandIds<TIcon extends string, TAssetName extends string>(
  toolset: ToolsetDefinition<TIcon, TAssetName>
): string[] {
  return toolset.groups.flatMap((group) => group.items.flatMap(toolsetItemCommandIds));
}

function toolsetItemCommandIds<TIcon extends string, TAssetName extends string>(
  item: ToolsetItemDefinition<TIcon, TAssetName>
): string[] {
  const ids = item.commandId ? [item.commandId] : [];
  if (item.primary?.type === "command") {
    ids.push(item.primary.commandId);
  }
  item.submenu?.items.forEach((submenuItem) => ids.push(submenuItem.commandId));
  return [...new Set(ids)];
}

/** The item's OWN command id(s) (top-level + primary), excluding submenu commands. */
function toolsetItemPrimaryCommandIds<TIcon extends string, TAssetName extends string>(
  item: ToolsetItemDefinition<TIcon, TAssetName>
): string[] {
  const ids = item.commandId ? [item.commandId] : [];
  if (item.primary?.type === "command") {
    ids.push(item.primary.commandId);
  }
  return [...new Set(ids)];
}

/**
 * The command id used to match an item against command-keyed user customizations (reorder / hide /
 * overrides). Falls back from the legacy top-level `commandId` to `primary.commandId`, so items
 * authored in the new primary-only form are still reorderable/hideable.
 */
function toolsetItemCustomizationId<TIcon extends string, TAssetName extends string>(
  item: ToolsetItemDefinition<TIcon, TAssetName>
): string | undefined {
  if (item.commandId !== undefined) {
    return item.commandId;
  }
  if (item.primary?.type === "command") {
    return item.primary.commandId;
  }
  // Control (widget) items are customizable by their controlId, so the editor can hide/reorder them
  // like commands (a `widget.*` controlId is a valid CommandId per CommandIdSchema).
  if (item.primary?.type === "control") {
    return item.primary.controlId;
  }
  return undefined;
}
