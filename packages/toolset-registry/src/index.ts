import { z } from "zod";

const NonEmptyStringSchema = z.string().min(1);

export const ToolsetSourceSchema = z.enum(["core", "plugin", "user"]);
export const ToolsetModeSchema = z.enum(["floating", "docked", "hidden"]);

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
    commandId: NonEmptyStringSchema,
    title: NonEmptyStringSchema.optional(),
    icon: NonEmptyStringSchema.optional(),
    assetName: NonEmptyStringSchema.optional(),
    shortcutDisplay: z.string().optional(),
    disabledReason: z.string().optional(),
    category: z.string().optional()
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
    category: z.string().optional()
  })
  .strict();

export const ToolsetManifestSchema = z
  .object({
    toolsets: z.array(ToolsetDefinitionSchema).min(1)
  })
  .strict();

export type ToolsetSource = z.infer<typeof ToolsetSourceSchema>;
export type ToolsetMode = z.infer<typeof ToolsetModeSchema>;
export type ToolsetWindowSize = z.infer<typeof ToolsetWindowSizeSchema>;

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
