import type { CSSProperties } from "react";
import type { NativeTextStyle } from "@chemdraft/chem-core";
import type { CommandSpec } from "./commands";
import {
  textAlignmentCommands,
  textColorCommands,
  textFontCommands,
  textSizeCommands
} from "./commands";
import { Icon } from "./icons";
import { toolbarAsset } from "./toolbarAssets";

export type ToolPaletteMode = "docked" | "floating";
export type ToolPaletteOrientation = "vertical" | "horizontal";

export function ToolPalette({
  groups,
  activeTool,
  mode = "docked",
  orientation = "vertical",
  title = "Drawing tools",
  showMainStyleControls = false,
  currentTextStyle,
  onInvoke
}: {
  groups: CommandSpec[][];
  activeTool: string;
  mode?: ToolPaletteMode;
  orientation?: ToolPaletteOrientation;
  title?: string;
  showMainStyleControls?: boolean;
  currentTextStyle?: NativeTextStyle;
  onInvoke: (commandId: string) => void;
}) {
  return (
    <aside className={["tool-palette", mode, orientation].join(" ")} aria-label={title} data-tool-palette-orientation={orientation}>
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
      {showMainStyleControls ? (
        <MainToolbarStyleControls
          currentTextStyle={currentTextStyle}
          onInvoke={onInvoke}
        />
      ) : null}
    </aside>
  );
}

function MainToolbarStyleControls({
  currentTextStyle,
  onInvoke
}: {
  currentTextStyle?: NativeTextStyle;
  onInvoke: (commandId: string) => void;
}) {
  const fontCommandId = closestFontCommandId(currentTextStyle?.fontFamily);
  const sizeCommandId = closestSizeCommandId(currentTextStyle?.fontSizePx);
  const textAlign = currentTextStyle?.textAlign ?? "left";
  const colorCommandId = closestColorCommandId(currentTextStyle?.color);

  return (
    <div className="main-toolbar-style-controls" data-toolbar-style-controls="main">
      <label className="toolbar-control-label">
        <span className="visually-hidden">Text font</span>
        <select
          className="toolbar-select toolbar-font-select"
          value={fontCommandId}
          aria-label="Text font"
          data-palette-control="true"
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => onInvoke(event.currentTarget.value)}
        >
          {textFontCommands.map((command) => (
            <option key={command.id} value={command.id}>
              {fontLabel(command.title)}
            </option>
          ))}
        </select>
      </label>
      <label className="toolbar-control-label">
        <span className="visually-hidden">Text size</span>
        <select
          className="toolbar-select toolbar-size-select"
          value={sizeCommandId}
          aria-label="Text size"
          data-palette-control="true"
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => onInvoke(event.currentTarget.value)}
        >
          {textSizeCommands.map((command) => (
            <option key={command.id} value={command.id}>
              {command.title.replace("Size: ", "")}
            </option>
          ))}
        </select>
      </label>
      <div className="toolbar-swatch-group" role="group" aria-label="Text color">
        {textColorCommands.map((command) => (
          <button
            type="button"
            className={["toolbar-color-swatch", colorCommandId === command.id ? "active" : ""].filter(Boolean).join(" ")}
            key={command.id}
            title={command.title}
            aria-label={command.title}
            aria-pressed={colorCommandId === command.id}
            data-command-id={command.id}
            data-palette-control="true"
            style={{ "--swatch-color": command.color } as CSSProperties}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onInvoke(command.id)}
          />
        ))}
      </div>
      <div className="toolbar-align-group" role="group" aria-label="Text alignment">
        {textAlignmentCommands.map((command) => (
          <button
            type="button"
            className={["toolbar-align-button", textAlign === command.textAlign ? "active" : ""].filter(Boolean).join(" ")}
            key={command.id}
            title={command.title}
            aria-label={command.title}
            aria-pressed={textAlign === command.textAlign}
            data-command-id={command.id}
            data-palette-control="true"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onInvoke(command.id)}
          >
            <span className={`toolbar-align-glyph toolbar-align-${command.textAlign}`} aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function fontLabel(title: string): string {
  return title.replace(/^Font: /, "").replace("System Sans", "Arial");
}

function closestFontCommandId(fontFamily: string | undefined): string {
  return textFontCommands.find((command) => fontFamily === command.fontFamily)?.id ?? textFontCommands[0].id;
}

function closestSizeCommandId(fontSizePx: number | undefined): string {
  if (fontSizePx === undefined) {
    return textSizeCommands[2]?.id ?? textSizeCommands[0].id;
  }

  return textSizeCommands.reduce((best, command) => (
    Math.abs(command.fontSizePx - fontSizePx) < Math.abs(best.fontSizePx - fontSizePx) ? command : best
  ), textSizeCommands[0]).id;
}

function closestColorCommandId(color: string | undefined): string {
  return textColorCommands.find((command) => color?.toLowerCase() === command.color.toLowerCase())?.id ?? textColorCommands[0].id;
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
