import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import type { NativeTextStyle, TextSpan } from "@chemdraft/chem-core";
import {
  objectStrokeDashCommands,
  objectStrokeWidthCommands,
  textAlignmentCommands,
  textFontCommands,
  textFontFamilyCommandId,
  textSizeCommands
} from "../commands";
import { loadSystemFonts, type SystemFontFace, type SystemFontFamily } from "../systemFonts";

/**
 * The 24px-cell building blocks toolbar widgets are made of: color swatches, text/glyph toggles,
 * alignment buttons, the font/size selects, and the shared pointer-invoke handler. They live below
 * ToolPalette (which imports them back up) so widget modules can use them without importing the
 * 5k-line palette renderer — the same layering rule described in toolbarWidgets.tsx.
 */

export type ColorCommand = {
  id: string;
  title: string;
  color: string;
};

/** Shared invoke wiring for palette buttons: fire once on pointerdown (with mouse/click fallbacks
 *  for environments without PointerEvent), and stop propagation so the palette-window drag logic
 *  doesn't eat the press. */
export function usePaletteButtonInvoke(
  commandId: string,
  onInvoke: (commandId: string) => void,
  disabled = false
) {
  const pointerInvokedRef = useRef(false);

  return {
    onPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
      event.stopPropagation();
      if (disabled || event.button !== 0) {
        return;
      }

      pointerInvokedRef.current = true;
      onInvoke(commandId);
    },
    onMouseDown(event: ReactMouseEvent<HTMLButtonElement>) {
      event.stopPropagation();
      if (pointerInvokedRef.current || disabled || event.button !== 0) {
        return;
      }

      pointerInvokedRef.current = true;
      onInvoke(commandId);
    },
    onClick() {
      if (pointerInvokedRef.current) {
        pointerInvokedRef.current = false;
        return;
      }

      if (!disabled) {
        onInvoke(commandId);
      }
    }
  };
}

export function ToolbarTextButton({
  active,
  children,
  commandId,
  disabled,
  label,
  onInvoke
}: {
  active: boolean;
  children: ReactNode;
  commandId: string;
  disabled?: boolean;
  label: string;
  onInvoke: (commandId: string) => void;
}) {
  const invokeHandlers = usePaletteButtonInvoke(commandId, onInvoke, disabled);

  return (
    <button
      type="button"
      className={["toolbar-text-button", active ? "active" : ""].filter(Boolean).join(" ")}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      data-command-id={commandId}
      data-palette-control="true"
      {...invokeHandlers}
    >
      {children}
    </button>
  );
}

export function ToolbarColorSwatchButton({
  active,
  command,
  onInvoke
}: {
  active: boolean;
  command: ColorCommand;
  onInvoke: (commandId: string) => void;
}) {
  const invokeHandlers = usePaletteButtonInvoke(command.id, onInvoke);

  return (
    <button
      type="button"
      className={["toolbar-color-swatch", active ? "active" : ""].filter(Boolean).join(" ")}
      title={command.title}
      aria-label={command.title}
      aria-pressed={active}
      data-command-id={command.id}
      data-palette-control="true"
      style={{ "--swatch-color": command.color } as CSSProperties}
      {...invokeHandlers}
    />
  );
}

export function ToolbarAlignButton({
  active,
  command,
  onInvoke
}: {
  active: boolean;
  command: typeof textAlignmentCommands[number];
  onInvoke: (commandId: string) => void;
}) {
  const invokeHandlers = usePaletteButtonInvoke(command.id, onInvoke);

  return (
    <button
      type="button"
      className={["toolbar-align-button", active ? "active" : ""].filter(Boolean).join(" ")}
      title={command.title}
      aria-label={command.title}
      aria-pressed={active}
      data-command-id={command.id}
      data-palette-control="true"
      {...invokeHandlers}
    >
      <span className={`toolbar-align-glyph toolbar-align-${command.textAlign}`} aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </button>
  );
}

export function ScriptGlyph({ script }: { script: TextSpan["script"] }) {
  if (script === "normal") {
    return <span className="toolbar-script-glyph" data-text-script="normal">x</span>;
  }

  return (
    <span className="toolbar-script-glyph" data-text-script={script}>
      x<span>2</span>
    </span>
  );
}

// Text objects can use any installed font. The four legacy presets stay pinned at the
// top for quick access; the full system catalog (shared with the atom-label picker via
// loadSystemFonts) follows. A non-preset family round-trips through a dynamic
// `text.font.family:` command id, mirroring how custom text colors are applied.
export function TextFontSelect({
  currentTextStyle,
  labelClassName,
  onInvoke
}: {
  currentTextStyle?: NativeTextStyle;
  labelClassName: string;
  onInvoke: (commandId: string) => void;
}) {
  const currentFontFamily = currentTextStyle?.fontFamily;
  const presetCommandId = presetTextFontCommandId(currentFontFamily);
  // A non-preset family is a specific installed font; keep it selectable even before the
  // catalog resolves (and on the web build, where there is no system-font bridge).
  const customFamily = presetCommandId ? undefined : currentFontFamily?.trim() || undefined;
  const [systemFonts, setSystemFonts] = useState<SystemFontFamily[]>([]);

  useEffect(() => {
    let disposed = false;
    void loadSystemFonts(customFamily ? [customFamily] : []).then((fonts) => {
      if (!disposed) {
        setSystemFonts(fonts);
      }
    });
    return () => {
      disposed = true;
    };
  }, [customFamily]);

  const systemFontFamilies = systemFonts.length > 0
    ? systemFonts
    : customFamily
      ? [{ family: customFamily, faces: defaultFontFaces() }]
      : [];
  const value = presetCommandId
    ?? (customFamily ? textFontFamilyCommandId(customFamily) : textFontCommands[0].id);

  return (
    <label className={labelClassName}>
      <span className="visually-hidden">Text font</span>
      <select
        className="toolbar-select toolbar-font-select"
        value={value}
        aria-label="Text font"
        data-palette-control="true"
        onPointerDown={(event) => event.stopPropagation()}
        onChange={(event) => onInvoke(event.currentTarget.value)}
      >
        <optgroup label="Suggested">
          {textFontCommands.map((command) => (
            <option key={command.id} value={command.id}>
              {fontLabel(command.title)}
            </option>
          ))}
        </optgroup>
        {systemFontFamilies.length > 0 ? (
          <optgroup label="System fonts">
            {systemFontFamilies.map((font) => (
              <option key={font.family} value={textFontFamilyCommandId(font.family)}>
                {fontFamilyLabel(font.family)}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
    </label>
  );
}

export function fontLabel(title: string): string {
  return title.replace(/^Font: /, "").replace("System Sans", "Arial");
}

export function presetTextFontCommandId(fontFamily: string | undefined): string | undefined {
  return textFontCommands.find((command) => fontFamily === command.fontFamily)?.id;
}

export function closestSizeCommandId(fontSizePx: number | undefined): string {
  if (fontSizePx === undefined) {
    return textSizeCommands[2]?.id ?? textSizeCommands[0].id;
  }

  return textSizeCommands.reduce((best, command) => (
    Math.abs(command.fontSizePx - fontSizePx) < Math.abs(best.fontSizePx - fontSizePx) ? command : best
  ), textSizeCommands[0]).id;
}

export function defaultFontFaces(): SystemFontFace[] {
  return [
    { weight: 400, style: "normal" },
    { weight: 700, style: "normal" },
    { weight: 400, style: "italic" },
    { weight: 700, style: "italic" }
  ];
}

export function fontFamilyLabel(fontFamily: string): string {
  return fontFamily.split(",")[0]?.replace(/^["']|["']$/g, "") ?? fontFamily;
}

export function closestObjectStrokeWidthCommandId(strokeWidth: number | undefined): string {
  if (strokeWidth === undefined) {
    return objectStrokeWidthCommands[1]?.id ?? objectStrokeWidthCommands[0].id;
  }

  return objectStrokeWidthCommands.reduce((best, command) => (
    Math.abs(command.strokeWidth - strokeWidth) < Math.abs(best.strokeWidth - strokeWidth) ? command : best
  ), objectStrokeWidthCommands[0]).id;
}

export function objectStrokeDashCommandId(strokeDasharray: string | undefined): string {
  const normalized = strokeDasharray === undefined || strokeDasharray === "solid" ? undefined : strokeDasharray;
  return objectStrokeDashCommands.find((command) => command.strokeDasharray === normalized)?.id ??
    objectStrokeDashCommands[0].id;
}
