import { isValidToolsetCommandId, parseToolsetToggleCommandId } from "@chemdraft/toolset-registry";
import { isCompoundLayoutCommandHidden, type CompoundLayoutSettings } from "../compoundLayoutSettings";
import { parseCustomSwatchCommandId } from "../customColorSwatches";
import { isCompatOnlyArtVariantCommandId, TRANSITIONAL_STUB_COMMAND_IDS } from "../drawingTools";
import { isRenamedCommandId } from "../renamedCommands";
import { SHELL_COMMAND_IDS } from "../shellCommandIds";
import { getToolsetCommandSpecs, shippedToolsetRegistry, PLUGIN_COMMAND_WITHOUT_HANDLER } from "../toolsets";

// Use the shipped manifest so removing a tool from a customized layout cannot make it
// disappear from the catalog of commands the user can add back.
const shippedCommandIds = new Set(getToolsetCommandSpecs(shippedToolsetRegistry).map((command) => command.id));

/** Filter unavailable features and retired tools. Commands disabled by the current selection
 *  or document state are still eligible for customization. */
export function filterToolbarCustomizationCommands<T extends { id: string; source?: "core" | "plugin"; disabledReason?: string }>(
  commands: readonly T[],
  settings: CompoundLayoutSettings
): T[] {
  return commands.filter(({ id, source, disabledReason }) =>
    (SHELL_COMMAND_IDS.has(id) || source === "plugin" || parseToolsetToggleCommandId(id) !== undefined) &&
    disabledReason !== PLUGIN_COMMAND_WITHOUT_HANDLER &&
    isValidToolsetCommandId(id) &&
    !parseCustomSwatchCommandId(id) &&
    !id.startsWith("object.wave.") &&
    !isRenamedCommandId(id) &&
    !isCompoundLayoutCommandHidden(id, settings) &&
    !TRANSITIONAL_STUB_COMMAND_IDS.has(id) &&
    !isCompatOnlyArtVariantCommandId(id, shippedCommandIds)
  );
}
