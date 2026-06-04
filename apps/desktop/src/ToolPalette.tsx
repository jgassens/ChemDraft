import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { NativeTextStyle, TextSpan } from "@chemdraft/chem-core";
import type { CommandSpec } from "./commands";
import {
  normalizeHexColor,
  textCustomColorCommandId,
  textAlignmentCommands,
  textColorCommands,
  textFontCommands,
  textLetterSpacingCommands,
  textLineHeightCommands,
  textParagraphSpacingCommands,
  textScriptCommands,
  textSizeCommands
} from "./commands";
import { Icon } from "./icons";
import { toolbarAsset } from "./toolbarAssets";

export type ToolPaletteMode = "docked" | "floating";
export type ToolPaletteOrientation = "vertical" | "horizontal";

const mainToolbarTextColorCommands = textColorCommands.filter((command) => (
  command.id === "text.color.black"
  || command.id === "text.color.white"
  || command.id === "text.color.blue"
  || command.id === "text.color.red"
  || command.id === "text.color.green"
  || command.id === "text.color.gray"
));

export function ToolPalette({
  groups,
  activeTool = "tool.select",
  mode = "docked",
  orientation = "vertical",
  title = "Drawing tools",
  showMainStyleControls = false,
  showTextStyleControls = false,
  currentTextStyle,
  currentTextScript,
  onColorPickerOpenChange,
  onInvoke
}: {
  groups: CommandSpec[][];
  activeTool?: string;
  mode?: ToolPaletteMode;
  orientation?: ToolPaletteOrientation;
  title?: string;
  showMainStyleControls?: boolean;
  showTextStyleControls?: boolean;
  currentTextStyle?: NativeTextStyle;
  currentTextScript?: TextSpan["script"];
  onColorPickerOpenChange?: (open: boolean) => void;
  onInvoke: (commandId: string) => void;
}) {
  return (
    <aside
      className={[
        "tool-palette",
        mode,
        orientation,
        showMainStyleControls ? "main-style-palette" : "",
        showTextStyleControls ? "text-style-palette" : ""
      ].filter(Boolean).join(" ")}
      aria-label={title}
      data-tool-palette-orientation={orientation}
    >
      {mode === "floating" ? (
        <span
          className="palette-content-drag-grip"
          aria-hidden="true"
          data-palette-content-drag-grip="true"
          data-tauri-drag-region="true"
        />
      ) : null}
      {groups.map((group) => (
        <div className="tool-group" key={group.map((tool) => tool.id).join("-")}>
          {group.map((tool) => (
            <CommandIconButton
              key={tool.id}
              command={tool}
              active={tool.enabled !== false && activeTool === tool.id}
              onInvoke={onInvoke}
              showShortcut
            />
          ))}
        </div>
      ))}
      {showMainStyleControls ? (
        <MainToolbarStyleControls
          currentTextStyle={currentTextStyle}
          currentTextScript={currentTextScript}
          onInvoke={onInvoke}
        />
      ) : null}
      {showTextStyleControls ? (
        <TextToolbarStyleControls
          currentTextStyle={currentTextStyle}
          currentTextScript={currentTextScript}
          onColorPickerOpenChange={onColorPickerOpenChange}
          onInvoke={onInvoke}
        />
      ) : null}
    </aside>
  );
}

function MainToolbarStyleControls({
  currentTextStyle,
  currentTextScript = "normal",
  onInvoke
}: {
  currentTextStyle?: NativeTextStyle;
  currentTextScript?: TextSpan["script"];
  onInvoke: (commandId: string) => void;
}) {
  const fontCommandId = closestFontCommandId(currentTextStyle?.fontFamily);
  const sizeCommandId = closestSizeCommandId(currentTextStyle?.fontSizePx);
  const textAlign = currentTextStyle?.textAlign ?? "left";
  const currentColor = normalizeHexColor(currentTextStyle?.color) ?? textColorCommands[0].color;
  const boldActive = (currentTextStyle?.fontWeight ?? 400) >= 600;
  const italicActive = currentTextStyle?.fontStyle === "italic";
  const underlineActive = currentTextStyle?.textDecoration === "underline";

  return (
    <div className="main-toolbar-style-controls" data-toolbar-style-controls="main">
      <div className="toolbar-style-row toolbar-style-row-primary">
        <div className="toolbar-swatch-group" role="group" aria-label="Text color">
          {mainToolbarTextColorCommands.map((command) => (
            <button
              type="button"
              className={[
                "toolbar-color-swatch",
                normalizeHexColor(command.color) === currentColor ? "active" : ""
              ].filter(Boolean).join(" ")}
              key={command.id}
              title={command.title}
              aria-label={command.title}
              aria-pressed={normalizeHexColor(command.color) === currentColor}
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
      <div className="toolbar-style-row toolbar-style-row-secondary">
        <label className="toolbar-control-label toolbar-font-control">
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
        <label className="toolbar-control-label toolbar-size-control">
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
        <div className="toolbar-type-group" role="group" aria-label="Text style">
          <ToolbarTextButton
            commandId="text.bold"
            label="Bold Text"
            active={boldActive}
            onInvoke={onInvoke}
          >
            B
          </ToolbarTextButton>
          <ToolbarTextButton
            commandId="text.italic"
            label="Italic Text"
            active={italicActive}
            onInvoke={onInvoke}
          >
            I
          </ToolbarTextButton>
          <ToolbarTextButton
            commandId="text.underline"
            label="Underline Text"
            active={underlineActive}
            onInvoke={onInvoke}
          >
            U
          </ToolbarTextButton>
          {textScriptCommands.filter((command) => command.script !== "normal").map((command) => (
            <ToolbarTextButton
              commandId={command.id}
              label={command.title}
              active={currentTextScript === command.script}
              key={command.id}
              onInvoke={onInvoke}
            >
              <span className="toolbar-script-glyph" data-text-script={command.script}>
                x<span>{command.script === "subscript" ? "2" : "2"}</span>
              </span>
            </ToolbarTextButton>
          ))}
        </div>
      </div>
    </div>
  );
}

function TextToolbarStyleControls({
  currentTextStyle,
  currentTextScript = "normal",
  onColorPickerOpenChange,
  onInvoke
}: {
  currentTextStyle?: NativeTextStyle;
  currentTextScript?: TextSpan["script"];
  onColorPickerOpenChange?: (open: boolean) => void;
  onInvoke: (commandId: string) => void;
}) {
  const fontCommandId = closestFontCommandId(currentTextStyle?.fontFamily);
  const sizeCommandId = closestSizeCommandId(currentTextStyle?.fontSizePx);
  const textAlign = currentTextStyle?.textAlign ?? "left";
  const currentColor = normalizeHexColor(currentTextStyle?.color) ?? textColorCommands[0].color;
  const letterSpacingCommandId = closestLetterSpacingCommandId(currentTextStyle?.letterSpacingPx);
  const lineHeightCommandId = closestLineHeightCommandId(currentTextStyle?.lineHeight);
  const paragraphSpacingCommandId = closestParagraphSpacingCommandId(currentTextStyle?.paragraphSpacingPx);
  const boldActive = (currentTextStyle?.fontWeight ?? 400) >= 600;
  const italicActive = currentTextStyle?.fontStyle === "italic";
  const underlineActive = currentTextStyle?.textDecoration === "underline";

  return (
    <div className="text-toolbar-style-controls" data-toolbar-style-controls="text">
      <div className="text-toolbar-row text-toolbar-row-font">
        <label className="toolbar-control-label text-toolbar-font-control">
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
        <label className="toolbar-control-label text-toolbar-size-control">
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
        <ColorPickerControl
          currentColor={currentColor}
          onOpenChange={onColorPickerOpenChange}
          onInvoke={onInvoke}
        />
      </div>
      <div className="text-toolbar-row">
        <div className="toolbar-type-group" role="group" aria-label="Text style">
          <ToolbarTextButton commandId="text.bold" label="Bold Text" active={boldActive} onInvoke={onInvoke}>
            B
          </ToolbarTextButton>
          <ToolbarTextButton commandId="text.italic" label="Italic Text" active={italicActive} onInvoke={onInvoke}>
            I
          </ToolbarTextButton>
          <ToolbarTextButton commandId="text.underline" label="Underline Text" active={underlineActive} onInvoke={onInvoke}>
            U
          </ToolbarTextButton>
          {textScriptCommands.map((command) => (
            <ToolbarTextButton
              commandId={command.id}
              label={command.title}
              active={currentTextScript === command.script}
              key={command.id}
              onInvoke={onInvoke}
            >
              <ScriptGlyph script={command.script} />
            </ToolbarTextButton>
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
      <div className="text-toolbar-row">
        <div className="toolbar-metric-group" role="group" aria-label="Letter spacing">
          {textLetterSpacingCommands.map((command) => (
            <ToolbarTextButton
              commandId={command.id}
              label={command.title}
              active={letterSpacingCommandId === command.id}
              key={command.id}
              onInvoke={onInvoke}
            >
              {command.letterSpacingPx < 0 ? "AV-" : command.letterSpacingPx > 0 ? "AV+" : "AV"}
            </ToolbarTextButton>
          ))}
        </div>
        <div className="toolbar-metric-group" role="group" aria-label="Line spacing">
          {textLineHeightCommands.map((command) => (
            <ToolbarTextButton
              commandId={command.id}
              label={command.title}
              active={lineHeightCommandId === command.id}
              key={command.id}
              onInvoke={onInvoke}
            >
              {command.lineHeight.toFixed(command.lineHeight % 1 === 0 ? 0 : 1)}
            </ToolbarTextButton>
          ))}
        </div>
        <div className="toolbar-metric-group" role="group" aria-label="Paragraph spacing">
          {textParagraphSpacingCommands.map((command) => (
            <ToolbarTextButton
              commandId={command.id}
              label={command.title}
              active={paragraphSpacingCommandId === command.id}
              key={command.id}
              onInvoke={onInvoke}
            >
              {`P${command.paragraphSpacingPx}`}
            </ToolbarTextButton>
          ))}
        </div>
      </div>
    </div>
  );
}

type ColorPickerTab = "palette" | "mixer";

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface CmykColor {
  c: number;
  m: number;
  y: number;
  k: number;
}

function ColorPickerControl({
  compact = false,
  currentColor,
  onOpenChange,
  onInvoke
}: {
  compact?: boolean;
  currentColor: string;
  onOpenChange?: (open: boolean) => void;
  onInvoke: (commandId: string) => void;
}) {
  const normalizedCurrentColor = normalizeHexColor(currentColor) ?? textColorCommands[0].color;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ColorPickerTab>("palette");
  const [draftHex, setDraftHex] = useState(normalizedCurrentColor);
  const draftRgb = useMemo(() => hexToRgbColor(draftHex) ?? { r: 17, g: 17, b: 17 }, [draftHex]);
  const draftCmyk = useMemo(() => rgbToCmykColor(draftRgb), [draftRgb]);

  useEffect(() => {
    onOpenChange?.(open);
  }, [onOpenChange, open]);

  useEffect(() => {
    if (!open) {
      setDraftHex(normalizedCurrentColor);
    }
  }, [normalizedCurrentColor, open]);

  const setOpenState = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setDraftHex(normalizedCurrentColor);
    }
  };

  const applyColor = (color: string) => {
    const normalized = normalizeHexColor(color);
    if (!normalized) {
      return;
    }

    setDraftHex(normalized);
    onInvoke(textCustomColorCommandId(normalized));
  };

  const applyPresetColor = (command: typeof textColorCommands[number]) => {
    setDraftHex(command.color);
    onInvoke(command.id);
  };

  const updateRgbChannel = (channel: keyof RgbColor, value: string) => {
    applyColor(rgbToHexColor({
      ...draftRgb,
      [channel]: clampColorChannel(value)
    }));
  };

  const updateCmykChannel = (channel: keyof CmykColor, value: string) => {
    applyColor(rgbToHexColor(cmykToRgbColor({
      ...draftCmyk,
      [channel]: clampPercentChannel(value)
    })));
  };

  const updateHexInput = (value: string) => {
    const normalized = normalizeHexColor(value);
    if (normalized) {
      applyColor(normalized);
      return;
    }

    setDraftHex(`#${value.replace(/[^0-9a-f]/gi, "").slice(0, 6).toLowerCase()}`.padEnd(7, "0"));
  };

  return (
    <div
      className={["toolbar-color-picker", compact ? "compact" : ""].filter(Boolean).join(" ")}
      role="group"
      aria-label="Text color"
      data-color-picker="true"
      data-palette-control="true"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="toolbar-color-trigger"
        aria-label="Open text color picker"
        aria-expanded={open}
        data-color-picker-trigger="true"
        data-palette-control="true"
        style={{ "--picker-color": normalizedCurrentColor } as CSSProperties}
        onClick={() => setOpenState(!open)}
      >
        <span className="toolbar-color-trigger-swatch" aria-hidden="true" />
        <span className="toolbar-color-trigger-label">Color</span>
      </button>
      {open ? (
        <div className="toolbar-color-popover" role="dialog" aria-label="Text color picker">
          <div className="color-picker-tabs" role="tablist" aria-label="Color picker mode">
            <button
              type="button"
              className={tab === "palette" ? "active" : ""}
              role="tab"
              aria-selected={tab === "palette"}
              onClick={() => setTab("palette")}
            >
              Palette
            </button>
            <button
              type="button"
              className={tab === "mixer" ? "active" : ""}
              role="tab"
              aria-selected={tab === "mixer"}
              onClick={() => setTab("mixer")}
            >
              Mixer
            </button>
          </div>
          {tab === "palette" ? (
            <div className="color-preset-panel" role="tabpanel" aria-label="Preset colors">
              <div className="color-preset-grid">
                {textColorCommands.map((command) => (
                  <button
                    type="button"
                    className={["color-preset-swatch", normalizeHexColor(command.color) === normalizedCurrentColor ? "active" : ""].filter(Boolean).join(" ")}
                    key={command.id}
                    title={command.title}
                    aria-label={command.title}
                    aria-pressed={normalizeHexColor(command.color) === normalizedCurrentColor}
                    data-command-id={command.id}
                    style={{ "--swatch-color": command.color } as CSSProperties}
                    onClick={() => applyPresetColor(command)}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="color-mixer-panel" role="tabpanel" aria-label="Custom color mixer">
              <label className="color-wheel-control">
                <span className="visually-hidden">Color wheel</span>
                <input
                  className="color-wheel-input"
                  type="color"
                  value={draftHex}
                  aria-label="Color wheel"
                  onChange={(event) => applyColor(event.currentTarget.value)}
                />
                <span className="color-wheel-face" aria-hidden="true">
                  <span className="color-wheel-current" style={{ "--picker-color": draftHex } as CSSProperties} />
                </span>
              </label>
              <div className="color-channel-groups">
                <div className="color-channel-group" aria-label="RGB color">
                  {(["r", "g", "b"] as const).map((channel) => (
                    <label key={channel}>
                      <span>{channel.toUpperCase()}</span>
                      <input
                        type="number"
                        min={0}
                        max={255}
                        value={draftRgb[channel]}
                        onChange={(event) => updateRgbChannel(channel, event.currentTarget.value)}
                      />
                    </label>
                  ))}
                </div>
                <div className="color-channel-group" aria-label="CMYK color">
                  {(["c", "m", "y", "k"] as const).map((channel) => (
                    <label key={channel}>
                      <span>{channel.toUpperCase()}</span>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={draftCmyk[channel]}
                        onChange={(event) => updateCmykChannel(channel, event.currentTarget.value)}
                      />
                    </label>
                  ))}
                </div>
                <label className="color-hex-field">
                  <span>HEX</span>
                  <input
                    type="text"
                    value={draftHex.toUpperCase()}
                    spellCheck={false}
                    onChange={(event) => updateHexInput(event.currentTarget.value)}
                  />
                </label>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ToolbarTextButton({
  active,
  children,
  commandId,
  label,
  onInvoke
}: {
  active: boolean;
  children: ReactNode;
  commandId: string;
  label: string;
  onInvoke: (commandId: string) => void;
}) {
  return (
    <button
      type="button"
      className={["toolbar-text-button", active ? "active" : ""].filter(Boolean).join(" ")}
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-command-id={commandId}
      data-palette-control="true"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => onInvoke(commandId)}
    >
      {children}
    </button>
  );
}

function ScriptGlyph({ script }: { script: TextSpan["script"] }) {
  if (script === "normal") {
    return <span className="toolbar-script-glyph" data-text-script="normal">x</span>;
  }

  return (
    <span className="toolbar-script-glyph" data-text-script={script}>
      x<span>2</span>
    </span>
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

export function hexToRgbColor(hex: string): RgbColor | undefined {
  const normalized = normalizeHexColor(hex);
  if (!normalized) {
    return undefined;
  }

  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16)
  };
}

export function rgbToHexColor(color: RgbColor): string {
  return `#${[color.r, color.g, color.b].map((channel) => clampColorChannel(channel).toString(16).padStart(2, "0")).join("")}`;
}

export function rgbToCmykColor(color: RgbColor): CmykColor {
  const r = clampColorChannel(color.r) / 255;
  const g = clampColorChannel(color.g) / 255;
  const b = clampColorChannel(color.b) / 255;
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) {
    return { c: 0, m: 0, y: 0, k: 100 };
  }

  return {
    c: Math.round(((1 - r - k) / (1 - k)) * 100),
    m: Math.round(((1 - g - k) / (1 - k)) * 100),
    y: Math.round(((1 - b - k) / (1 - k)) * 100),
    k: Math.round(k * 100)
  };
}

export function cmykToRgbColor(color: CmykColor): RgbColor {
  const c = clampPercentChannel(color.c) / 100;
  const m = clampPercentChannel(color.m) / 100;
  const y = clampPercentChannel(color.y) / 100;
  const k = clampPercentChannel(color.k) / 100;

  return {
    r: Math.round(255 * (1 - c) * (1 - k)),
    g: Math.round(255 * (1 - m) * (1 - k)),
    b: Math.round(255 * (1 - y) * (1 - k))
  };
}

function clampColorChannel(value: string | number): number {
  const numericValue = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  return Math.min(255, Math.max(0, Math.round(numericValue)));
}

function clampPercentChannel(value: string | number): number {
  const numericValue = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  return Math.min(100, Math.max(0, Math.round(numericValue)));
}

function closestLetterSpacingCommandId(letterSpacingPx: number | undefined): string {
  if (letterSpacingPx === undefined) {
    return "text.spacing.normal";
  }

  return textLetterSpacingCommands.reduce((best, command) => (
    Math.abs(command.letterSpacingPx - letterSpacingPx) < Math.abs(best.letterSpacingPx - letterSpacingPx) ? command : best
  ), textLetterSpacingCommands[0]).id;
}

function closestLineHeightCommandId(lineHeight: number | undefined): string {
  if (lineHeight === undefined) {
    return "text.lineHeight.normal";
  }

  return textLineHeightCommands.reduce((best, command) => (
    Math.abs(command.lineHeight - lineHeight) < Math.abs(best.lineHeight - lineHeight) ? command : best
  ), textLineHeightCommands[0]).id;
}

function closestParagraphSpacingCommandId(paragraphSpacingPx: number | undefined): string {
  if (paragraphSpacingPx === undefined) {
    return "text.paragraph.none";
  }

  return textParagraphSpacingCommands.reduce((best, command) => (
    Math.abs(command.paragraphSpacingPx - paragraphSpacingPx) < Math.abs(best.paragraphSpacingPx - paragraphSpacingPx) ? command : best
  ), textParagraphSpacingCommands[0]).id;
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
  const activeState = active && !disabled;
  const shortcut = command.shortcut ?? command.defaultShortcut;
  const shortcutLabel = command.shortcutLabel ?? shortcut;
  const shortcutText = shortcutLabel ? ` (${shortcutLabel})` : "";
  const stateText = disabled ? `: ${command.disabledReason ?? "unavailable"}` : "";

  return (
    <button
      type="button"
      className={["icon-button", activeState ? "active" : "", separated ? "separated" : ""].filter(Boolean).join(" ")}
      title={`${command.title}${shortcutText}${stateText}`}
      aria-label={`${command.title}${shortcutText}${stateText}`}
      aria-pressed={activeState || undefined}
      disabled={disabled}
      data-active={activeState ? "true" : undefined}
      data-command-id={command.id}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => onInvoke(command.id)}
    >
      {command.assetName ? (
        <img className="tool-icon-image" src={toolbarAsset(command.assetName)} alt="" aria-hidden="true" />
      ) : (
        <Icon name={command.icon} />
      )}
      {showShortcut && shortcutLabel ? <span className="shortcut">{shortcutLabel}</span> : null}
    </button>
  );
}
