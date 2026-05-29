import type { CommandSpec } from "./commands";
import { Icon } from "./icons";

export type ToolPaletteMode = "docked" | "floating";

export function ToolPalette({
  groups,
  activeTool,
  mode = "docked",
  onInvoke
}: {
  groups: CommandSpec[][];
  activeTool: string;
  mode?: ToolPaletteMode;
  onInvoke: (commandId: string) => void;
}) {
  return (
    <aside className={["tool-palette", mode].join(" ")} aria-label="Drawing tools">
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
  const shortcutText = command.shortcut ? ` (${command.shortcut})` : "";
  const stateText = disabled ? ": unavailable until an EditorAdapter or file workflow is connected" : "";

  return (
    <button
      type="button"
      className={["icon-button", active ? "active" : "", separated ? "separated" : ""].filter(Boolean).join(" ")}
      title={`${command.title}${shortcutText}${stateText}`}
      aria-label={`${command.title}${shortcutText}${stateText}`}
      aria-pressed={active || undefined}
      disabled={disabled}
      data-command-id={command.id}
      onClick={() => onInvoke(command.id)}
    >
      <Icon name={command.icon} />
      {showShortcut && command.shortcut ? <span className="shortcut">{command.shortcut}</span> : null}
    </button>
  );
}
