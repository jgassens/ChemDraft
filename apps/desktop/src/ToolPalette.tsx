import type { CommandSpec } from "./commands";
import { Icon } from "./icons";
import { toolbarAsset } from "./toolbarAssets";

export type ToolPaletteMode = "docked" | "floating";

export function ToolPalette({
  groups,
  activeTool,
  mode = "docked",
  title = "Drawing tools",
  onInvoke
}: {
  groups: CommandSpec[][];
  activeTool: string;
  mode?: ToolPaletteMode;
  title?: string;
  onInvoke: (commandId: string) => void;
}) {
  return (
    <aside className={["tool-palette", mode].join(" ")} aria-label={title}>
      {groups.map((group) => (
        <div className="tool-group" key={group.map((tool) => tool.id).join("-")}>
          {group.map((tool) => (
            <CommandIconButton
              key={tool.id}
              command={tool}
              active={activeTool === tool.id}
              onInvoke={onInvoke}
              showShortcut
            />
          ))}
        </div>
      ))}
    </aside>
  );
}

export function CommandIconButton({
  command,
  active = false,
  separated = false,
  showShortcut = false,
  onInvoke
}: {
  command: CommandSpec;
  active?: boolean;
  separated?: boolean;
  showShortcut?: boolean;
  onInvoke: (commandId: string) => void;
}) {
  const disabled = command.enabled === false;
  const shortcut = command.shortcut ?? command.defaultShortcut;
  const shortcutText = shortcut ? ` (${shortcut})` : "";
  const stateText = disabled ? `: ${command.disabledReason ?? "unavailable"}` : "";

  return (
    <button
      type="button"
      className={["icon-button", active ? "active" : "", separated ? "separated" : ""].filter(Boolean).join(" ")}
      title={`${command.title}${shortcutText}${stateText}`}
      aria-label={`${command.title}${shortcutText}${stateText}`}
      aria-pressed={active || undefined}
      disabled={disabled}
      data-command-id={command.id}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => onInvoke(command.id)}
    >
      {command.assetName ? (
        <img className="tool-icon-image" src={toolbarAsset(command.assetName)} alt="" aria-hidden="true" />
      ) : (
        <Icon name={command.icon} />
      )}
      {showShortcut && shortcut ? <span className="shortcut">{shortcut}</span> : null}
    </button>
  );
}
