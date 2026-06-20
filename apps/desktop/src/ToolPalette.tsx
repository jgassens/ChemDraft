import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import { HexColorPicker } from "react-colorful";
import type { NativeTextStyle, TextSpan } from "@chemdraft/chem-core";
import type { CommandSpec } from "./commands";
import {
  normalizeHexColor,
  distributeModeCommandIds,
  objectFillOpacityCommandId,
  objectOpacityCommandId,
  objectColorCommands,
  objectCustomColorCommandId,
  objectGradientAddStopCommand,
  objectGradientDeleteStopCommandId,
  objectGradientReverseCommand,
  objectGradientRotateCommand,
  objectGradientStopColorCommandId,
  objectGradientStopOffsetCommandId,
  objectGradientStopOpacityCommandId,
  objectEffectCommands,
  objectEffectColorCommandId,
  objectEffectDisableCommandId,
  objectEffectOpacityCommandId,
  objectEffectSizeCommandId,
  objectPaintTypeCommandId,
  objectPaintTypeCommands,
  objectStrokeDashCommands,
  objectStrokeLineCapCommands,
  objectStrokeLineJoinCommands,
  objectStrokeOpacityCommandId,
  objectStrokeWidthCommands,
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
import { toolbarAsset, type ToolbarAssetName } from "./toolbarAssets";
import type { ArtInspectorEffectKind } from "./artInspectorModel";
import type { ToolsetArtPaintTarget, ToolsetArtStylePayload } from "./window-manager";

export type ToolPaletteMode = "docked" | "floating";
export type ToolPaletteOrientation = "vertical" | "horizontal";
export type ToolPaletteDistributeMode = "centers" | "spacing";

const mainToolbarTextColorCommands = textColorCommands.filter((command) => (
  command.id === "text.color.black"
  || command.id === "text.color.white"
  || command.id === "text.color.blue"
  || command.id === "text.color.red"
  || command.id === "text.color.green"
  || command.id === "text.color.gray"
));
const TOOLTIP_DELAY_MS = 650;
const GRADIENT_STOP_DIRECT_DRAG_GAP = 0.01;
const DISTRIBUTE_MENU_HOLD_MS = 420;
const COMMAND_FLYOUT_HOLD_MS = 420;

const ART_ARRANGE_FLYOUTS = [
  {
    id: "align",
    title: "Align",
    commandIds: [
      "layout.alignLeft",
      "layout.alignCenter",
      "layout.alignRight",
      "layout.alignTop",
      "layout.alignMiddle",
      "layout.alignBottom"
    ]
  },
  {
    id: "layer",
    title: "Layer",
    commandIds: [
      "layout.bringToFront",
      "layout.bringForward",
      "layout.sendBackward",
      "layout.sendToBack"
    ]
  },
  {
    id: "transform",
    title: "Transform",
    commandIds: [
      "layout.flipHorizontal",
      "layout.flipVertical",
      "layout.rotate90",
      "layout.duplicate"
    ]
  },
  {
    id: "group",
    title: "Group",
    commandIds: [
      "layout.group",
      "layout.ungroup"
    ]
  }
] as const;

const ART_ARRANGE_STANDALONE_COMMAND_IDS = [
  "layout.distributeHorizontal",
  "layout.distributeVertical"
] as const;

const ART_ARRANGE_COMMAND_IDS: ReadonlySet<string> = new Set<string>(
  [
    ...ART_ARRANGE_FLYOUTS.flatMap((flyout) => flyout.commandIds),
    ...ART_ARRANGE_STANDALONE_COMMAND_IDS
  ]
);

const ART_SHAPE_COMMAND_IDS = [
  "tool.art.rect",
  "tool.art.roundedRect",
  "tool.art.circle",
  "tool.art.ellipse"
] as const;

export function ToolPalette({
  groups,
  activeTool = "tool.select",
  mode = "docked",
  orientation = "vertical",
  title = "Drawing tools",
  showMainStyleControls = false,
  showTextStyleControls = false,
  showArtStyleControls = false,
  currentDistributeMode = "centers",
  currentObjectColor,
  currentArtStyle,
  currentArtStyleTarget = "fill",
  currentTextStyle,
  currentTextScript,
  onColorPickerOpenChange,
  onArtStylePreview,
  onArtStyleCommit,
  onArtStyleCancel,
  onInvoke
}: {
  groups: CommandSpec[][];
  activeTool?: string;
  mode?: ToolPaletteMode;
  orientation?: ToolPaletteOrientation;
  title?: string;
  showMainStyleControls?: boolean;
  showTextStyleControls?: boolean;
  showArtStyleControls?: boolean;
  currentDistributeMode?: ToolPaletteDistributeMode;
  currentObjectColor?: string;
  currentArtStyle?: ToolsetArtStylePayload;
  currentArtStyleTarget?: ToolsetArtPaintTarget;
  currentTextStyle?: NativeTextStyle;
  currentTextScript?: TextSpan["script"];
  onColorPickerOpenChange?: (open: boolean) => void;
  onArtStylePreview?: (commandId: string) => void;
  onArtStyleCommit?: (commandId: string) => void;
  onArtStyleCancel?: () => void;
  onInvoke: (commandId: string) => void;
}) {
  const {
    visibleTooltipId,
    requestTooltip,
    clearTooltip
  } = usePaletteTooltipState();

  return (
    <aside
      className={[
        "tool-palette",
        mode,
        orientation,
        showMainStyleControls ? "main-style-palette" : "",
        showTextStyleControls ? "text-style-palette" : "",
        showArtStyleControls ? "art-style-palette" : ""
      ].filter(Boolean).join(" ")}
      aria-label={title}
      data-tool-palette-orientation={orientation}
      data-tooltip-delay-ms={TOOLTIP_DELAY_MS}
    >
      {mode === "floating" ? (
        <span
          className="palette-content-drag-grip"
          aria-hidden="true"
          data-palette-content-drag-grip="true"
          data-tauri-drag-region="true"
        />
      ) : null}
      {groups.map((group, groupIndex) => {
        const shapeFlyout = showArtStyleControls ? artShapeFlyoutForGroup(group) : undefined;
        if (shapeFlyout) {
          const tooltipId = `${groupIndex}-0-art-shape-${shapeFlyout.id}`;
          return (
            <div
              className="tool-group art-shape-flyout-group"
              key={`art-shape-${group.map((tool) => tool.id).join("-")}`}
              data-art-shape-flyout-group="true"
            >
              <CommandFlyoutButton
                commands={shapeFlyout.commands}
                distributeMode={currentDistributeMode}
                title={shapeFlyout.title}
                primaryAssetName="Art_Shapes"
                activeCommandId={activeTool}
                tooltipId={tooltipId}
                tooltipVisible={visibleTooltipId === tooltipId}
                onInvoke={onInvoke}
                onTooltipEnter={() => requestTooltip(tooltipId)}
                onTooltipLeave={() => clearTooltip(tooltipId)}
              />
            </div>
          );
        }

        const arrangeItems = showArtStyleControls ? artArrangeToolbarItemsForGroup(group) : [];
        if (arrangeItems.length > 0) {
          return (
            <div
              className="tool-group art-arrange-flyout-group"
              key={`art-arrange-${group.map((tool) => tool.id).join("-")}`}
              data-art-arrange-flyout-group="true"
            >
              {arrangeItems.map((item, itemIndex) => {
                const tooltipId = `${groupIndex}-${itemIndex}-art-arrange-${item.id}`;
                if (item.kind === "command") {
                  return (
                    <CommandIconButton
                      key={item.command.id}
                      command={item.command}
                      active={item.command.enabled !== false && activeTool === item.command.id}
                      tooltipId={tooltipId}
                      tooltipVisible={visibleTooltipId === tooltipId}
                      distributeMode={currentDistributeMode}
                      onTooltipEnter={() => requestTooltip(tooltipId)}
                      onTooltipLeave={() => clearTooltip(tooltipId)}
                      onInvoke={onInvoke}
                    />
                  );
                }

                return (
                  <CommandFlyoutButton
                    key={item.flyout.id}
                    commands={item.flyout.commands}
                    distributeMode={currentDistributeMode}
                    title={item.flyout.title}
                    activeCommandId={activeTool}
                    tooltipId={tooltipId}
                    tooltipVisible={visibleTooltipId === tooltipId}
                    onInvoke={onInvoke}
                    onTooltipEnter={() => requestTooltip(tooltipId)}
                    onTooltipLeave={() => clearTooltip(tooltipId)}
                  />
                );
              })}
            </div>
          );
        }

        return (
          <div className="tool-group" key={group.map((tool) => tool.id).join("-")}>
            {group.map((tool, toolIndex) => {
              const tooltipId = `${groupIndex}-${toolIndex}-${tool.id}`;
              return (
                <CommandIconButton
                  key={tool.id}
                  command={tool}
                  active={tool.enabled !== false && activeTool === tool.id}
                  tooltipId={tooltipId}
                  tooltipVisible={visibleTooltipId === tooltipId}
                  distributeMode={currentDistributeMode}
                  onTooltipEnter={() => requestTooltip(tooltipId)}
                  onTooltipLeave={() => clearTooltip(tooltipId)}
                  onInvoke={onInvoke}
                />
              );
            })}
          </div>
        );
      })}
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
      {showArtStyleControls ? (
        <ArtToolbarStyleControls
          currentObjectColor={currentObjectColor}
          currentArtStyle={currentArtStyle}
          currentArtStyleTarget={currentArtStyleTarget}
          onColorPickerOpenChange={onColorPickerOpenChange}
          onPreview={onArtStylePreview}
          onCommit={onArtStyleCommit}
          onCancel={onArtStyleCancel}
          onInvoke={onInvoke}
        />
      ) : null}
    </aside>
  );
}

function usePaletteTooltipState() {
  const [visibleTooltipId, setVisibleTooltipId] = useState<string | undefined>();
  const visibleTooltipIdRef = useRef<string | undefined>(undefined);
  const pendingTooltipRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingTooltipIdRef = useRef<string | undefined>(undefined);
  visibleTooltipIdRef.current = visibleTooltipId;

  const clearPendingTooltip = useCallback(() => {
    if (pendingTooltipRef.current !== undefined) {
      clearTimeout(pendingTooltipRef.current);
      pendingTooltipRef.current = undefined;
    }
    pendingTooltipIdRef.current = undefined;
  }, []);

  const requestTooltip = useCallback((tooltipId: string) => {
    if (visibleTooltipIdRef.current === tooltipId || pendingTooltipIdRef.current === tooltipId) {
      return;
    }

    clearPendingTooltip();
    setVisibleTooltipId(undefined);
    pendingTooltipIdRef.current = tooltipId;
    pendingTooltipRef.current = setTimeout(() => {
      pendingTooltipRef.current = undefined;
      pendingTooltipIdRef.current = undefined;
      setVisibleTooltipId(tooltipId);
    }, TOOLTIP_DELAY_MS);
  }, [clearPendingTooltip]);

  const clearTooltip = useCallback((tooltipId?: string) => {
    clearPendingTooltip();
    setVisibleTooltipId((current) => (
      tooltipId && current !== tooltipId ? current : undefined
    ));
  }, [clearPendingTooltip]);

  useEffect(() => {
    if (!visibleTooltipId) {
      return undefined;
    }

    const clearWhenPointerLeavesOwner = (event: MouseEvent | PointerEvent) => {
      const target = event.target;
      const targetElement = target instanceof Element
        ? target
        : target instanceof Node
          ? target.parentElement
          : undefined;
      const ownerElement = targetElement?.closest<HTMLElement>("[data-tooltip-owner-id]");

      if (ownerElement?.dataset.tooltipOwnerId !== visibleTooltipId) {
        clearTooltip(visibleTooltipId);
      }
    };

    const clearVisibleTooltip = () => {
      clearTooltip(visibleTooltipId);
    };

    document.addEventListener("mousemove", clearWhenPointerLeavesOwner, true);
    document.addEventListener("pointermove", clearWhenPointerLeavesOwner, true);
    document.addEventListener("mouseleave", clearVisibleTooltip, true);
    document.addEventListener("pointerdown", clearWhenPointerLeavesOwner, true);
    window.addEventListener("blur", clearVisibleTooltip);

    return () => {
      document.removeEventListener("mousemove", clearWhenPointerLeavesOwner, true);
      document.removeEventListener("pointermove", clearWhenPointerLeavesOwner, true);
      document.removeEventListener("mouseleave", clearVisibleTooltip, true);
      document.removeEventListener("pointerdown", clearWhenPointerLeavesOwner, true);
      window.removeEventListener("blur", clearVisibleTooltip);
    };
  }, [visibleTooltipId, clearTooltip]);

  useEffect(() => {
    const clearPendingOnBlur = () => {
      clearTooltip();
    };

    window.addEventListener("blur", clearPendingOnBlur);
    return () => {
      window.removeEventListener("blur", clearPendingOnBlur);
    };
  }, [clearTooltip]);

  useEffect(() => () => {
    clearPendingTooltip();
  }, [clearPendingTooltip]);

  return {
    visibleTooltipId,
    requestTooltip,
    clearTooltip
  };
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
            <ToolbarColorSwatchButton
              active={normalizeHexColor(command.color) === currentColor}
              command={command}
              key={command.id}
              onInvoke={onInvoke}
            />
          ))}
        </div>
        <div className="toolbar-align-group" role="group" aria-label="Text alignment">
          {textAlignmentCommands.map((command) => (
            <ToolbarAlignButton
              active={textAlign === command.textAlign}
              command={command}
              key={command.id}
              onInvoke={onInvoke}
            />
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
            <ToolbarAlignButton
              active={textAlign === command.textAlign}
              command={command}
              key={command.id}
              onInvoke={onInvoke}
            />
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

function closestObjectStrokeWidthCommandId(strokeWidth: number | undefined): string {
  if (strokeWidth === undefined) {
    return objectStrokeWidthCommands[1]?.id ?? objectStrokeWidthCommands[0].id;
  }

  return objectStrokeWidthCommands.reduce((best, command) => (
    Math.abs(command.strokeWidth - strokeWidth) < Math.abs(best.strokeWidth - strokeWidth) ? command : best
  ), objectStrokeWidthCommands[0]).id;
}

function objectStrokeDashCommandId(strokeDasharray: string | undefined): string {
  const normalized = strokeDasharray === undefined || strokeDasharray === "solid" ? undefined : strokeDasharray;
  return objectStrokeDashCommands.find((command) => command.strokeDasharray === normalized)?.id ??
    objectStrokeDashCommands[0].id;
}

function ArtToolbarStyleControls({
  currentObjectColor,
  currentArtStyle,
  currentArtStyleTarget,
  onColorPickerOpenChange,
  onPreview,
  onCommit,
  onCancel,
  onInvoke
}: {
  currentObjectColor?: string;
  currentArtStyle?: ToolsetArtStylePayload;
  currentArtStyleTarget: ToolsetArtPaintTarget;
  onColorPickerOpenChange?: (open: boolean) => void;
  onPreview?: (commandId: string) => void;
  onCommit?: (commandId: string) => void;
  onCancel?: () => void;
  onInvoke: (commandId: string) => void;
}) {
  const selectedCount = currentArtStyle?.selectedCount ?? 0;
  const selected = selectedCount > 0;
  const fillSupportedCount = currentArtStyle?.fillSupportedCount ?? 0;
  const strokeSupportedCount = currentArtStyle?.strokeSupportedCount ?? 0;
  const dashSupportedCount = currentArtStyle?.dashSupportedCount ?? 0;
  const lineEndsSupportedCount = currentArtStyle?.lineEndsSupportedCount ?? 0;
  const cornersSupportedCount = currentArtStyle?.cornersSupportedCount ?? 0;
  const supportsFill = currentArtStyle?.supportsFillAny ?? false;
  const supportsStroke = currentArtStyle?.supportsStrokeAny ?? false;
  const supportsDash = currentArtStyle?.supportsDashAny ?? false;
  const supportsLineEnds = currentArtStyle?.supportsLineEndsAny ?? false;
  const supportsCorners = currentArtStyle?.supportsCornersAny ?? false;
  const supportsFillAll = currentArtStyle?.supportsFillAll ?? false;
  const supportsStrokeAll = currentArtStyle?.supportsStrokeAll ?? false;
  const supportsDashAll = currentArtStyle?.supportsDashAll ?? false;
  const supportsLineEndsAll = currentArtStyle?.supportsLineEndsAll ?? false;
  const supportsCornersAll = currentArtStyle?.supportsCornersAll ?? false;
  const effectiveArtStyleTarget: ToolsetArtPaintTarget = currentArtStyle?.activePaintTarget ?? currentArtStyleTarget;
  const activeTargetSupported = effectiveArtStyleTarget === "fill" ? supportsFill : supportsStroke;
  const supportsStrokeWidth = supportsStroke && supportsDash;
  const activeColor = effectiveArtStyleTarget === "fill"
    ? currentArtStyle?.values.fillColor.value
    : currentArtStyle?.values.strokeColor.value;
  const currentColor = normalizeHexColor(activeColor ?? currentObjectColor) ?? objectColorCommands[0]?.color ?? "#111111";
  const activePaintTypeValue = effectiveArtStyleTarget === "fill"
    ? currentArtStyle?.values.fillPaintType.value
    : currentArtStyle?.values.strokePaintType.value;
  const activePaintTypeMixed = effectiveArtStyleTarget === "fill"
    ? currentArtStyle?.values.fillPaintType.mixed ?? false
    : currentArtStyle?.values.strokePaintType.mixed ?? false;
  const activePaintTypeCommandId = activePaintTypeMixed
    ? "object.paint.type.mixed"
    : objectPaintTypeCommandId(activePaintTypeValue ?? "solid");
  const activePaintTypeCommands = objectPaintTypeCommands.filter((command) =>
    effectiveArtStyleTarget === "fill" || command.paintType !== "gloss"
  );
  const colorPickerRef = useRef<HTMLDivElement | null>(null);
  const effectColorPickerRef = useRef<HTMLDivElement | null>(null);
  const gradientRailRef = useRef<HTMLDivElement | null>(null);
  const gradientStopColorPickerRef = useRef<HTMLDivElement | null>(null);
  const gradientStopDragRef = useRef<{ stopIndex: number; moved: boolean } | null>(null);
  const sliderDragRef = useRef<{ sliderKey: string; pointerId: number } | null>(null);
  const [colorOpen, setColorOpen] = useState(false);
  const [effectColorOpen, setEffectColorOpen] = useState(false);
  const [draftColor, setDraftColor] = useState(currentColor);
  const [draftEffectColor, setDraftEffectColor] = useState("#52616b");
  const [focusedEffectKind, setFocusedEffectKind] = useState<ArtInspectorEffectKind | undefined>();
  const [selectedGradientStopIndex, setSelectedGradientStopIndex] = useState(0);
  const [gradientStopColorOpen, setGradientStopColorOpen] = useState(false);
  const [draftGradientStopColor, setDraftGradientStopColor] = useState("#111111");
  const selectedStyleObjectIdsKey = currentArtStyle?.selectedObjectIds.join("\u0000") ?? "";
  const objectOpacity = currentArtStyle?.values.objectOpacity.value ?? 1;
  const fillOpacity = currentArtStyle?.values.fillOpacity.value ?? 1;
  const strokeOpacity = currentArtStyle?.values.strokeOpacity.value ?? 1;
  const activeEffectValue = currentArtStyle?.values.effect.value ?? "none";
  const activeEffectKinds = currentArtStyle?.effectKinds ?? [];
  const activeEffectKindsKey = activeEffectKinds.join("|");
  const visibleEffectKind = focusedEffectKind && (activeEffectKinds.includes(focusedEffectKind) || selected)
    ? focusedEffectKind
    : activeEffectValue === "shadow" || activeEffectValue === "glow" || activeEffectValue === "sketch"
      ? activeEffectValue
      : activeEffectKinds[0];
  const visibleEffectModel = visibleEffectKind ? currentArtStyle?.effectControls[visibleEffectKind] : undefined;
  const currentEffectColor = visibleEffectModel?.color.value ?? "#52616b";
  const draftEffectRgb = useMemo(() => hexToRgbColor(draftEffectColor) ?? { r: 17, g: 17, b: 17 }, [draftEffectColor]);
  const draftEffectCmyk = useMemo(() => rgbToCmykColor(draftEffectRgb), [draftEffectRgb]);
  const effectOpacity = visibleEffectModel?.opacity.value ?? 1;
  const effectSize = visibleEffectModel?.size.value ?? 0.25;
  const showEffectControls = selected && visibleEffectKind !== undefined && (visibleEffectModel?.presentCount ?? 0) > 0;
  const strokeWidthCommandId = closestObjectStrokeWidthCommandId(currentArtStyle?.values.strokeWidth.value ?? undefined);
  const strokeDashCommandId = objectStrokeDashCommandId(currentArtStyle?.values.dash.value ?? undefined);
  const strokeCap = currentArtStyle?.values.lineEnds.value ?? "butt";
  const strokeJoin = currentArtStyle?.values.corners.value ?? "miter";
  const activeGradient = currentArtStyle?.activeGradient;
  const showGradientControls = selected && activeTargetSupported && Boolean(activeGradient?.editable || activeGradient?.mixed);
  const activeGradientStops = activeGradient?.stops ?? [];
  const activeGradientStopsKey = activeGradientStops
    .map((stop) => `${stop.offset}:${stop.color}:${stop.opacity}`)
    .join("|");
  const activeGradientStopIndex = activeGradientStops.length > 0
    ? Math.min(selectedGradientStopIndex, activeGradientStops.length - 1)
    : 0;
  const activeGradientStop = activeGradientStops[activeGradientStopIndex];
  const currentGradientStopColor = activeGradientStop?.color ?? currentColor;
  const currentGradientStopOpacity = activeGradientStop?.opacity ?? 1;
  const currentGradientStopOffset = activeGradientStop?.offset ?? 0;
  const showGradientStopEditor = showGradientControls && activeGradient?.editable === true && activeGradientStop !== undefined;
  const gradientRailStyle = {
    "--art-gradient-rail": activeGradientStops.length > 0
      ? artGradientRailCss(activeGradientStops)
      : "repeating-linear-gradient(135deg, var(--cd-bg-control) 0 5px, var(--cd-border-subtle) 5px 10px)"
  } as CSSProperties;
  const showAdvancedStrokeControls = false;

  useEffect(() => {
    onColorPickerOpenChange?.(colorOpen || effectColorOpen || gradientStopColorOpen);
  }, [colorOpen, effectColorOpen, gradientStopColorOpen, onColorPickerOpenChange]);

  useEffect(() => {
    if (!colorOpen) {
      setDraftColor(currentColor);
    }
  }, [colorOpen, currentColor]);

  useEffect(() => {
    if (!gradientStopColorOpen) {
      setDraftGradientStopColor(currentGradientStopColor);
    }
  }, [currentGradientStopColor, gradientStopColorOpen]);

  useEffect(() => {
    if (!effectColorOpen) {
      setDraftEffectColor(currentEffectColor);
    }
  }, [currentEffectColor, effectColorOpen]);

  useEffect(() => {
    const maxIndex = activeGradientStops.length - 1;
    setSelectedGradientStopIndex((current) => maxIndex < 0 ? 0 : Math.max(0, Math.min(maxIndex, current)));
  }, [activeGradientStops.length, activeGradientStopsKey]);

  useEffect(() => {
    if (!colorOpen && !effectColorOpen && !gradientStopColorOpen) {
      return undefined;
    }

    const closeForOutsidePointer = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && colorPickerRef.current?.contains(target)) {
        return;
      }
      if (target instanceof Node && effectColorPickerRef.current?.contains(target)) {
        return;
      }
      if (target instanceof Node && gradientStopColorPickerRef.current?.contains(target)) {
        return;
      }
      setColorOpen(false);
      setEffectColorOpen(false);
      setGradientStopColorOpen(false);
    };
    const closeForEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      setColorOpen(false);
      setEffectColorOpen(false);
      setGradientStopColorOpen(false);
      onCancel?.();
    };
    const closeForWindowBlur = () => {
      setColorOpen(false);
      setEffectColorOpen(false);
      setGradientStopColorOpen(false);
    };

    document.addEventListener("pointerdown", closeForOutsidePointer, true);
    document.addEventListener("keydown", closeForEscape, true);
    window.addEventListener("blur", closeForWindowBlur);
    return () => {
      document.removeEventListener("pointerdown", closeForOutsidePointer, true);
      document.removeEventListener("keydown", closeForEscape, true);
      window.removeEventListener("blur", closeForWindowBlur);
    };
  }, [colorOpen, effectColorOpen, gradientStopColorOpen, onCancel]);

  useEffect(() => {
    setColorOpen(false);
    setEffectColorOpen(false);
    setGradientStopColorOpen(false);
  }, [selectedStyleObjectIdsKey]);

  useEffect(() => {
    setFocusedEffectKind((current) => {
      if (current && activeEffectKinds.includes(current)) {
        return current;
      }
      return activeEffectValue === "shadow" || activeEffectValue === "glow" || activeEffectValue === "sketch"
        ? activeEffectValue
        : activeEffectKinds[0];
    });
  }, [activeEffectKindsKey, activeEffectValue]);

  const invokeOrCommit = (commandId: string) => {
    if (onCommit) {
      onCommit(commandId);
      return;
    }
    onInvoke(commandId);
  };

  const previewCommand = (commandId: string) => {
    onPreview?.(commandId);
  };

  const supportTitle = (label: string, supportedCount: number, supportsAll = supportedCount === selectedCount) =>
    selected && supportedCount > 0 && !supportsAll
      ? `${label} applies to ${supportedCount} of ${selectedCount} selected graphics`
      : label;

  const updateColor = (color: string) => {
    const normalized = normalizeHexColor(color);
    if (!normalized) {
      return;
    }
    setDraftColor(normalized);
    previewCommand(objectCustomColorCommandId(normalized));
  };

  const commitColor = (color: string) => {
    const normalized = normalizeHexColor(color);
    if (!normalized) {
      return;
    }
    setDraftColor(normalized);
    invokeOrCommit(objectCustomColorCommandId(normalized));
  };

  const updateEffectColor = (color: string) => {
    const normalized = normalizeHexColor(color);
    if (!normalized || !visibleEffectKind) {
      return;
    }
    setDraftEffectColor(normalized);
    previewCommand(objectEffectColorCommandId(visibleEffectKind, normalized));
  };

  const commitEffectColor = (color: string) => {
    const normalized = normalizeHexColor(color);
    if (!normalized || !visibleEffectKind) {
      return;
    }
    setDraftEffectColor(normalized);
    invokeOrCommit(objectEffectColorCommandId(visibleEffectKind, normalized));
  };

  const updateEffectRgbChannel = (channel: keyof RgbColor, value: string) => {
    updateEffectColor(rgbToHexColor({
      ...draftEffectRgb,
      [channel]: clampColorChannel(value)
    }));
  };

  const updateEffectCmykChannel = (channel: keyof CmykColor, value: string) => {
    updateEffectColor(rgbToHexColor(cmykToRgbColor({
      ...draftEffectCmyk,
      [channel]: clampPercentChannel(value)
    })));
  };

  const updateEffectHexInput = (value: string) => {
    const normalized = normalizeHexColor(value);
    if (normalized) {
      updateEffectColor(normalized);
      return;
    }

    setDraftEffectColor(`#${value.replace(/[^0-9a-f]/gi, "").slice(0, 6).toLowerCase()}`.padEnd(7, "0"));
  };

  const updateGradientStopColor = (color: string) => {
    const normalized = normalizeHexColor(color);
    if (!normalized || !activeGradientStop) {
      return;
    }
    setDraftGradientStopColor(normalized);
    previewCommand(objectGradientStopColorCommandId(activeGradientStopIndex, normalized));
  };

  const commitGradientStopColor = (color: string) => {
    const normalized = normalizeHexColor(color);
    if (!normalized || !activeGradientStop) {
      return;
    }
    setDraftGradientStopColor(normalized);
    invokeOrCommit(objectGradientStopColorCommandId(activeGradientStopIndex, normalized));
  };

  const gradientStopOffsetForClientX = (stopIndex: number, clientX: number): number | undefined => {
    const railRect = gradientRailRef.current?.getBoundingClientRect();
    if (!railRect || railRect.width <= 0) {
      return undefined;
    }
    const rawOffset = Math.max(0, Math.min(1, (clientX - railRect.left) / railRect.width));
    const previousStop = activeGradientStops[stopIndex - 1];
    const nextStop = activeGradientStops[stopIndex + 1];
    const minimumOffset = previousStop
      ? Math.min(1, previousStop.offset + GRADIENT_STOP_DIRECT_DRAG_GAP)
      : 0;
    const maximumOffset = nextStop
      ? Math.max(0, nextStop.offset - GRADIENT_STOP_DIRECT_DRAG_GAP)
      : 1;
    if (minimumOffset > maximumOffset) {
      return rawOffset;
    }
    return Math.max(minimumOffset, Math.min(maximumOffset, rawOffset));
  };

  const previewGradientStopOffset = (stopIndex: number, clientX: number): boolean => {
    const offset = gradientStopOffsetForClientX(stopIndex, clientX);
    if (offset === undefined) {
      return false;
    }
    previewCommand(objectGradientStopOffsetCommandId(stopIndex, offset));
    return true;
  };

  const commitGradientStopOffset = (stopIndex: number, clientX: number): boolean => {
    const offset = gradientStopOffsetForClientX(stopIndex, clientX);
    if (offset === undefined) {
      return false;
    }
    invokeOrCommit(objectGradientStopOffsetCommandId(stopIndex, offset));
    return true;
  };

  const applyGradientStopOffsetKey = (
    stopIndex: number,
    currentOffset: number,
    event: ReactKeyboardEvent<HTMLButtonElement>
  ) => {
    let nextOffset = currentOffset;
    if (event.key === "Home") {
      nextOffset = 0;
    } else if (event.key === "End") {
      nextOffset = 1;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      nextOffset = currentOffset - (event.shiftKey ? 0.1 : 0.01);
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      nextOffset = currentOffset + (event.shiftKey ? 0.1 : 0.01);
    } else {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const previousStop = activeGradientStops[stopIndex - 1];
    const nextStop = activeGradientStops[stopIndex + 1];
    const minimumOffset = previousStop
      ? Math.min(1, previousStop.offset + GRADIENT_STOP_DIRECT_DRAG_GAP)
      : 0;
    const maximumOffset = nextStop
      ? Math.max(0, nextStop.offset - GRADIENT_STOP_DIRECT_DRAG_GAP)
      : 1;
    const clampedOffset = minimumOffset <= maximumOffset
      ? Math.max(minimumOffset, Math.min(maximumOffset, nextOffset))
      : Math.max(0, Math.min(1, nextOffset));
    invokeOrCommit(objectGradientStopOffsetCommandId(stopIndex, clampedOffset));
  };

  const opacitySlider = (
    label: string,
    shortLabel: string,
    value: number,
    commandId: (opacity: number) => string,
    supportedCount = selectedCount
  ) => {
    const percent = Math.round(value * 100);
    const sliderKey = label.toLowerCase().replace(/\s+/g, "-");
    const applySliderPercent = (nextPercent: number, commit: boolean) => {
      const normalizedPercent = Math.max(0, Math.min(100, Math.round(nextPercent)));
      const command = commandId(normalizedPercent / 100);
      if (commit) {
        invokeOrCommit(command);
      } else {
        previewCommand(command);
      }
    };
    const sliderOwnsPointer = (event: ReactPointerEvent<HTMLInputElement>) =>
      sliderDragRef.current?.sliderKey === sliderKey && sliderDragRef.current.pointerId === event.pointerId;
    const applySliderPointer = (event: ReactPointerEvent<HTMLInputElement>, commit: boolean) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const nextPercent = rect.width > 0 ? (event.clientX - rect.left) / rect.width * 100 : percent;
      event.currentTarget.value = `${Math.max(0, Math.min(100, Math.round(nextPercent)))}`;
      applySliderPercent(nextPercent, commit);
    };
    const applySliderKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
      const currentPercent = Number(event.currentTarget.value);
      const basePercent = Number.isFinite(currentPercent) ? currentPercent : percent;
      let nextPercent = basePercent;
      if (event.key === "Home") {
        nextPercent = 0;
      } else if (event.key === "End") {
        nextPercent = 100;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
        nextPercent = basePercent - (event.shiftKey ? 10 : 1);
      } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
        nextPercent = basePercent + (event.shiftKey ? 10 : 1);
      } else {
        return;
      }
      event.preventDefault();
      event.currentTarget.value = `${Math.max(0, Math.min(100, Math.round(nextPercent)))}`;
      applySliderPercent(nextPercent, true);
    };
    return (
      <label className="art-inspector-slider" data-art-inspector-slider={sliderKey}>
        <span className="art-inspector-slider-header">
          <span className="art-inspector-slider-label">{shortLabel}</span>
          <span className="art-inspector-slider-value">{percent}%</span>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          value={percent}
          disabled={!selected || supportedCount === 0}
          aria-label={label}
          title={`${supportTitle(label, supportedCount)}: ${percent}%`}
          data-palette-control="true"
          onPointerDown={(event) => {
            event.stopPropagation();
            sliderDragRef.current = { sliderKey, pointerId: event.pointerId };
            if (typeof event.currentTarget.setPointerCapture === "function") {
              event.currentTarget.setPointerCapture(event.pointerId);
            }
            applySliderPointer(event, false);
          }}
          onPointerMove={(event) => {
            if (event.buttons === 1 && sliderOwnsPointer(event)) {
              applySliderPointer(event, false);
            }
          }}
          onPointerUp={(event) => {
            event.stopPropagation();
            if (!sliderOwnsPointer(event)) {
              return;
            }
            if (
              typeof event.currentTarget.hasPointerCapture === "function" &&
              event.currentTarget.hasPointerCapture(event.pointerId) &&
              typeof event.currentTarget.releasePointerCapture === "function"
            ) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            sliderDragRef.current = null;
            applySliderPointer(event, true);
          }}
          onPointerCancel={(event) => {
            if (sliderOwnsPointer(event)) {
              if (
                typeof event.currentTarget.hasPointerCapture === "function" &&
                event.currentTarget.hasPointerCapture(event.pointerId) &&
                typeof event.currentTarget.releasePointerCapture === "function"
              ) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              sliderDragRef.current = null;
            }
          }}
          onChange={(event) => {
            if (sliderDragRef.current?.sliderKey === sliderKey) {
              previewCommand(commandId(Number(event.currentTarget.value) / 100));
            }
          }}
          onKeyDown={applySliderKey}
          onBlur={() => {
            if (sliderDragRef.current?.sliderKey === sliderKey) {
              sliderDragRef.current = null;
            }
          }}
        />
      </label>
    );
  };

  return (
    <div
      className="art-toolbar-style-controls"
      data-toolbar-style-controls="art"
      data-art-selection-count={currentArtStyle?.selectedCount ?? 0}
      data-art-fill-supported-count={fillSupportedCount}
      data-art-stroke-supported-count={strokeSupportedCount}
      data-art-dash-supported-count={dashSupportedCount}
      data-art-line-ends-supported-count={lineEndsSupportedCount}
      data-art-corners-supported-count={cornersSupportedCount}
      data-art-fill-support-all={currentArtStyle?.supportsFillAll ?? false}
      data-art-stroke-support-all={currentArtStyle?.supportsStrokeAll ?? false}
      data-art-dash-support-all={currentArtStyle?.supportsDashAll ?? false}
      data-art-line-ends-support-all={currentArtStyle?.supportsLineEndsAll ?? false}
      data-art-corners-support-all={currentArtStyle?.supportsCornersAll ?? false}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onCancel?.();
          setColorOpen(false);
        }
      }}
    >
      <div className="art-inspector-row">
        <div className="art-target-toggle" role="group" aria-label="Art paint target">
          {supportsFill ? (
            <button
              type="button"
              className={effectiveArtStyleTarget === "fill" ? "active" : ""}
              aria-label="Target fill"
              title={supportTitle("Target fill color", fillSupportedCount, supportsFillAll)}
              disabled={!selected}
              data-command-id="object.style.target.fill"
              data-palette-control="true"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onInvoke("object.style.target.fill")}
            >
              <span className="art-target-fill-glyph" aria-hidden="true" />
            </button>
          ) : null}
          {supportsStroke ? (
            <button
              type="button"
              className={effectiveArtStyleTarget === "stroke" ? "active" : ""}
              aria-label="Target stroke"
              title={supportTitle("Target stroke color", strokeSupportedCount, supportsStrokeAll)}
              disabled={!selected}
              data-command-id="object.style.target.stroke"
              data-palette-control="true"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onInvoke("object.style.target.stroke")}
            >
              <span className="art-target-stroke-glyph" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <label
          className="toolbar-control-label art-paint-type-control"
          title={`${effectiveArtStyleTarget === "fill" ? "Fill" : "Stroke"} paint type`}
        >
          <select
            className="toolbar-select"
            value={activePaintTypeCommandId}
            aria-label={`${effectiveArtStyleTarget === "fill" ? "Fill" : "Stroke"} paint type`}
            disabled={!selected || !activeTargetSupported}
            data-art-paint-type-select={effectiveArtStyleTarget}
            data-palette-control="true"
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => onInvoke(event.currentTarget.value)}
          >
            {activePaintTypeMixed ? (
              <option value="object.paint.type.mixed">Mixed</option>
            ) : null}
            {activePaintTypeCommands.map((command) => (
              <option key={command.id} value={command.id}>
                {command.label}
              </option>
            ))}
          </select>
        </label>
        <div
          className="art-color-picker"
          role="group"
          aria-label={`${effectiveArtStyleTarget === "fill" ? "Fill" : "Stroke"} color`}
          ref={colorPickerRef}
          data-color-picker="true"
          data-palette-control="true"
        >
          <button
            type="button"
            className="toolbar-color-trigger"
            aria-label="Open object color picker"
            aria-expanded={colorOpen}
            disabled={!selected || !activeTargetSupported}
            title={`Pick ${supportTitle(
              effectiveArtStyleTarget,
              effectiveArtStyleTarget === "fill" ? fillSupportedCount : strokeSupportedCount,
              effectiveArtStyleTarget === "fill" ? supportsFillAll : supportsStrokeAll
            )} color`}
            style={{ "--picker-color": currentColor } as CSSProperties}
            onClick={() => {
              setGradientStopColorOpen(false);
              setColorOpen((open) => !open);
            }}
          >
            <span className="toolbar-color-trigger-swatch" aria-hidden="true" />
            <span className="toolbar-color-trigger-label">{effectiveArtStyleTarget === "fill" ? "Fill" : "Stroke"}</span>
          </button>
          {colorOpen ? (
            <div className="art-color-popover" role="dialog" aria-label="Art color picker">
              <HexColorPicker color={draftColor} onChange={updateColor} onChangeEnd={commitColor} />
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className="art-inspector-symbol-button"
          aria-label={effectiveArtStyleTarget === "fill" ? "No fill" : "No stroke"}
          title={effectiveArtStyleTarget === "fill"
            ? supportTitle("No fill", fillSupportedCount, supportsFillAll)
            : supportTitle("No stroke", strokeSupportedCount, supportsStrokeAll)}
          disabled={!selected || !activeTargetSupported}
          data-command-id={effectiveArtStyleTarget === "fill" ? "object.style.fill.none" : "object.style.stroke.none"}
          data-palette-control="true"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onInvoke(effectiveArtStyleTarget === "fill" ? "object.style.fill.none" : "object.style.stroke.none")}
        >
          ∅
        </button>
        <button
          type="button"
          className="art-inspector-symbol-button"
          aria-label="Swap fill and stroke"
          title="Swap fill and stroke"
          disabled={!selected || !supportsFill || !supportsStroke}
          data-command-id="object.style.swapFillStroke"
          data-palette-control="true"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onInvoke("object.style.swapFillStroke")}
        >
          ⇄
        </button>
        <div className="art-effect-button-group" role="group" aria-label="Art effects">
          {objectEffectCommands.map((command) => {
            const effectKind = command.effectKind;
            const active = effectKind !== "none" && activeEffectKinds.includes(effectKind);
            return (
              <button
                type="button"
                key={command.id}
                className={active ? "active" : ""}
                aria-pressed={active}
                aria-label={command.title}
                title={command.title}
                disabled={!selected}
                data-command-id={command.id}
                data-art-effect-button={effectKind}
                data-palette-control="true"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => {
                  if (effectKind !== "none") {
                    setFocusedEffectKind(effectKind);
                    if (!active) {
                      onInvoke(command.id);
                    }
                    return;
                  }

                  setFocusedEffectKind(undefined);
                  setEffectColorOpen(false);
                  onInvoke(command.id);
                }}
                onDoubleClick={() => {
                  if (effectKind === "none" || !active) {
                    return;
                  }

                  setFocusedEffectKind(undefined);
                  setEffectColorOpen(false);
                  onInvoke(objectEffectDisableCommandId(effectKind));
                }}
              >
                {command.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="art-inspector-row art-inspector-opacity-row">
        {opacitySlider("Object opacity", "Obj", objectOpacity, objectOpacityCommandId)}
        {supportsFill ? opacitySlider("Fill opacity", "Fill", fillOpacity, objectFillOpacityCommandId, fillSupportedCount) : null}
        {supportsStroke ? opacitySlider("Stroke opacity", "Stroke", strokeOpacity, objectStrokeOpacityCommandId, strokeSupportedCount) : null}
      </div>
      {showEffectControls && visibleEffectKind ? (
        <div
          className="art-inspector-row art-effect-row"
          data-art-effect-controls={visibleEffectKind}
          data-art-effect-present-count={visibleEffectModel?.presentCount ?? 0}
          data-art-effect-present-all={visibleEffectModel?.presentAll ?? false}
        >
          <div
            className="art-color-picker art-effect-color-picker"
            role="group"
            aria-label={`${effectLabel(visibleEffectKind)} effect color`}
            ref={effectColorPickerRef}
            data-color-picker="true"
            data-palette-control="true"
          >
            <button
              type="button"
              className="toolbar-color-trigger art-effect-color-trigger"
              aria-label={`Open ${effectLabel(visibleEffectKind)} effect color picker`}
              aria-expanded={effectColorOpen}
              title={`${effectLabel(visibleEffectKind)} effect color`}
              data-art-effect-color-trigger={visibleEffectKind}
              data-palette-control="true"
              style={{ "--picker-color": currentEffectColor } as CSSProperties}
              onClick={() => {
                setColorOpen(false);
                setGradientStopColorOpen(false);
                setEffectColorOpen((open) => !open);
              }}
            >
              <span className="toolbar-color-trigger-swatch" aria-hidden="true" />
              <span className="toolbar-color-trigger-label">Effect</span>
            </button>
            {effectColorOpen ? (
              <div
                className="art-color-popover art-effect-color-popover"
                role="dialog"
                aria-label={`${effectLabel(visibleEffectKind)} effect color picker`}
              >
                <HexColorPicker color={draftEffectColor} onChange={updateEffectColor} onChangeEnd={commitEffectColor} />
                <div className="color-mixer-panel" role="group" aria-label="Effect color mixer">
                  <label className="color-wheel-control">
                    <span className="visually-hidden">Effect color wheel</span>
                    <input
                      className="color-wheel-input"
                      type="color"
                      value={draftEffectColor}
                      aria-label="Effect color wheel"
                      onChange={(event) => updateEffectColor(event.currentTarget.value)}
                      onBlur={(event) => commitEffectColor(event.currentTarget.value)}
                    />
                    <span className="color-wheel-face" aria-hidden="true">
                      <span className="color-wheel-current" style={{ "--picker-color": draftEffectColor } as CSSProperties} />
                    </span>
                  </label>
                  <div className="color-channel-groups">
                    <div className="color-channel-group" aria-label="Effect RGB color">
                      {(["r", "g", "b"] as const).map((channel) => (
                        <label key={channel}>
                          <span>{channel.toUpperCase()}</span>
                          <input
                            type="number"
                            min={0}
                            max={255}
                            value={draftEffectRgb[channel]}
                            onBlur={() => commitEffectColor(draftEffectColor)}
                            onChange={(event) => updateEffectRgbChannel(channel, event.currentTarget.value)}
                          />
                        </label>
                      ))}
                    </div>
                    <div className="color-channel-group" aria-label="Effect CMYK color">
                      {(["c", "m", "y", "k"] as const).map((channel) => (
                        <label key={channel}>
                          <span>{channel.toUpperCase()}</span>
                          <input
                            type="number"
                            min={0}
                            max={100}
                            value={draftEffectCmyk[channel]}
                            onBlur={() => commitEffectColor(draftEffectColor)}
                            onChange={(event) => updateEffectCmykChannel(channel, event.currentTarget.value)}
                          />
                        </label>
                      ))}
                    </div>
                    <label className="color-hex-field">
                      <span>HEX</span>
                      <input
                        type="text"
                        value={draftEffectColor.toUpperCase()}
                        spellCheck={false}
                        onBlur={() => commitEffectColor(draftEffectColor)}
                        onChange={(event) => updateEffectHexInput(event.currentTarget.value)}
                      />
                    </label>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
          {opacitySlider(
            `${effectLabel(visibleEffectKind)} effect opacity`,
            "Eff",
            effectOpacity,
            (opacity) => objectEffectOpacityCommandId(visibleEffectKind, opacity),
            visibleEffectModel?.presentCount ?? 0
          )}
          {opacitySlider(
            `${effectLabel(visibleEffectKind)} effect size`,
            "Size",
            effectSize,
            (size) => objectEffectSizeCommandId(visibleEffectKind, size),
            visibleEffectModel?.presentCount ?? 0
          )}
        </div>
      ) : null}
      {showGradientControls ? (
        <div className="art-inspector-row art-gradient-row" data-art-gradient-controls={effectiveArtStyleTarget}>
          <div
            ref={gradientRailRef}
            className="art-gradient-rail"
            data-art-gradient-rail={effectiveArtStyleTarget}
            data-art-gradient-type={activeGradient?.paintType ?? undefined}
            data-art-gradient-mixed={activeGradient?.mixed ? "true" : undefined}
            style={gradientRailStyle}
          >
            {activeGradientStops.map((stop, index) => (
              <button
                type="button"
                key={`gradient-stop-${index}`}
                className={[
                  "art-gradient-stop-marker",
                  index === activeGradientStopIndex ? "active" : ""
                ].filter(Boolean).join(" ")}
                aria-label={`Drag gradient stop ${index + 1} at ${Math.round(stop.offset * 100)}%`}
                title="Drag to move gradient stop; use arrow keys for 1% nudges"
                data-command-id={objectGradientStopOffsetCommandId(index, stop.offset)}
                data-art-gradient-stop={index}
                data-art-gradient-stop-active={index === activeGradientStopIndex ? "true" : undefined}
                data-palette-control="true"
                style={{
                  "--art-gradient-stop-color": stop.color,
                  "--art-gradient-stop-offset": `${Math.round(stop.offset * 100)}%`,
                  opacity: stop.opacity
                } as CSSProperties}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  event.preventDefault();
                  setSelectedGradientStopIndex(index);
                  setGradientStopColorOpen(false);
                  gradientStopDragRef.current = { stopIndex: index, moved: false };
                  if (typeof event.currentTarget.setPointerCapture === "function") {
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }
                }}
                onPointerMove={(event) => {
                  const drag = gradientStopDragRef.current;
                  if (drag?.stopIndex !== index || event.buttons !== 1) {
                    return;
                  }
                  event.stopPropagation();
                  event.preventDefault();
                  if (previewGradientStopOffset(index, event.clientX)) {
                    drag.moved = true;
                  }
                }}
                onPointerUp={(event) => {
                  const drag = gradientStopDragRef.current;
                  event.stopPropagation();
                  if (typeof event.currentTarget.hasPointerCapture === "function" &&
                    event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                  if (drag?.stopIndex === index && drag.moved) {
                    commitGradientStopOffset(index, event.clientX);
                  }
                  gradientStopDragRef.current = null;
                }}
                onPointerCancel={(event) => {
                  const drag = gradientStopDragRef.current;
                  if (typeof event.currentTarget.hasPointerCapture === "function" &&
                    event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                  gradientStopDragRef.current = null;
                  if (drag?.moved) {
                    onCancel?.();
                  }
                }}
                onKeyDown={(event) => applyGradientStopOffsetKey(index, stop.offset, event)}
                onClick={() => setSelectedGradientStopIndex(index)}
              />
            ))}
          </div>
          <button
            type="button"
            className="art-inspector-symbol-button"
            aria-label="Add gradient stop"
            title="Add gradient stop"
            disabled={!activeGradient?.canAddStop}
            data-command-id={objectGradientAddStopCommand.id}
            data-palette-control="true"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => {
              setSelectedGradientStopIndex(nextInsertedGradientStopIndex(activeGradientStops));
              onInvoke(objectGradientAddStopCommand.id);
            }}
          >
            +
          </button>
          <button
            type="button"
            className="art-inspector-symbol-button"
            aria-label="Delete selected gradient stop"
            title="Delete selected gradient stop"
            disabled={!activeGradient?.canDeleteStop}
            data-command-id={objectGradientDeleteStopCommandId(activeGradientStopIndex)}
            data-palette-control="true"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => {
              setSelectedGradientStopIndex((current) => Math.max(0, current - 1));
              onInvoke(objectGradientDeleteStopCommandId(activeGradientStopIndex));
            }}
          >
            −
          </button>
            <button
            type="button"
            className="art-inspector-symbol-button"
            aria-label="Reverse gradient stops"
            title="Reverse gradient stops"
            disabled={!activeGradient?.editable}
            data-command-id={objectGradientReverseCommand.id}
            data-palette-control="true"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onInvoke(objectGradientReverseCommand.id)}
          >
            ⇆
          </button>
          <button
            type="button"
            className="art-inspector-symbol-button"
            aria-label="Rotate gradient stops"
            title="Rotate gradient stops"
            disabled={!activeGradient?.editable}
            data-command-id={objectGradientRotateCommand.id}
            data-palette-control="true"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onInvoke(objectGradientRotateCommand.id)}
          >
            ↻
          </button>
        </div>
      ) : null}
      {showGradientStopEditor ? (
        <div
          className="art-inspector-row art-gradient-stop-editor"
          data-art-gradient-stop-editor={effectiveArtStyleTarget}
          data-art-gradient-active-stop={activeGradientStopIndex}
          data-art-gradient-stop-color={currentGradientStopColor}
          data-art-gradient-stop-offset={currentGradientStopOffset}
        >
          <span className="art-gradient-stop-readout">
            {`Stop ${activeGradientStopIndex + 1} · ${Math.round(currentGradientStopOffset * 100)}%`}
          </span>
          <div
            className="art-color-picker art-gradient-stop-color-picker"
            role="group"
            aria-label="Gradient stop color"
            ref={gradientStopColorPickerRef}
            data-color-picker="true"
            data-palette-control="true"
          >
            <button
              type="button"
              className="toolbar-color-trigger art-gradient-stop-color-trigger"
              aria-label="Open gradient stop color picker"
              aria-expanded={gradientStopColorOpen}
              title="Pick gradient stop color"
              data-art-gradient-stop-color-trigger="true"
              data-palette-control="true"
              style={{ "--picker-color": currentGradientStopColor } as CSSProperties}
              onClick={() => {
                setColorOpen(false);
                setGradientStopColorOpen((open) => !open);
              }}
            >
              <span className="toolbar-color-trigger-swatch" aria-hidden="true" />
              <span className="toolbar-color-trigger-label">Stop</span>
            </button>
            {gradientStopColorOpen ? (
              <div className="art-color-popover" role="dialog" aria-label="Gradient stop color picker">
                <HexColorPicker
                  color={draftGradientStopColor}
                  onChange={updateGradientStopColor}
                  onChangeEnd={commitGradientStopColor}
                />
              </div>
            ) : null}
          </div>
          {opacitySlider(
            "Gradient stop opacity",
            "Stop",
            currentGradientStopOpacity,
            (opacity) => objectGradientStopOpacityCommandId(activeGradientStopIndex, opacity)
          )}
        </div>
      ) : null}
      {supportsStrokeWidth || supportsDash || (showAdvancedStrokeControls && (supportsLineEnds || supportsCorners)) ? (
      <div className="art-inspector-row art-inspector-stroke-row">
        {supportsStrokeWidth ? (
        <label className="toolbar-control-label art-stroke-width-control art-stroke-control">
          <span className="art-stroke-control-label">Width</span>
          <select
            className="toolbar-select"
            value={strokeWidthCommandId}
            aria-label="Stroke width"
            disabled={!selected}
            title={supportTitle("Stroke width", dashSupportedCount, supportsDashAll)}
            data-palette-control="true"
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => onInvoke(event.currentTarget.value)}
          >
            {objectStrokeWidthCommands.map((command) => (
              <option key={command.id} value={command.id}>
                {command.strokeWidth}px
              </option>
            ))}
          </select>
        </label>
        ) : null}
        {supportsDash ? (
        <label className="toolbar-control-label art-stroke-dash-control art-stroke-control">
          <span className="art-stroke-control-label">Dash</span>
          <select
            className="toolbar-select"
            value={strokeDashCommandId}
            aria-label="Dash pattern"
            disabled={!selected}
            title={supportTitle("Dash pattern", dashSupportedCount, supportsDashAll)}
            data-palette-control="true"
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => onInvoke(event.currentTarget.value)}
          >
            {objectStrokeDashCommands.map((command) => (
              <option key={command.id} value={command.id}>
                {command.title.replace(" Stroke", "")}
              </option>
            ))}
          </select>
        </label>
        ) : null}
        {showAdvancedStrokeControls && supportsLineEnds ? (
        <label className="toolbar-control-label art-stroke-cap-control art-stroke-control">
          <span className="art-stroke-control-label">Line ends</span>
          <select
            className="toolbar-select"
            value={`object.stroke.cap.${strokeCap}`}
            aria-label="Line ends"
            disabled={!selected}
            title={supportTitle("Line ends", lineEndsSupportedCount, supportsLineEndsAll)}
            data-palette-control="true"
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => onInvoke(event.currentTarget.value)}
          >
            {objectStrokeLineCapCommands.map((command) => (
              <option key={command.id} value={command.id}>
                {lineCapLabel(command.strokeLineCap)}
              </option>
            ))}
          </select>
        </label>
        ) : null}
        {showAdvancedStrokeControls && supportsCorners ? (
        <label className="toolbar-control-label art-stroke-join-control art-stroke-control">
          <span className="art-stroke-control-label">Corners</span>
          <select
            className="toolbar-select"
            value={`object.stroke.join.${strokeJoin}`}
            aria-label="Corners"
            disabled={!selected}
            title={supportTitle("Corners", cornersSupportedCount, supportsCornersAll)}
            data-palette-control="true"
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => onInvoke(event.currentTarget.value)}
          >
            {objectStrokeLineJoinCommands.map((command) => (
              <option key={command.id} value={command.id}>
                {lineJoinLabel(command.strokeLineJoin)}
              </option>
            ))}
          </select>
        </label>
        ) : null}
      </div>
      ) : null}
    </div>
  );
}

function lineCapLabel(value: "butt" | "round" | "square"): string {
  if (value === "butt") {
    return "Flat";
  }
  if (value === "round") {
    return "Round";
  }
  return "Square";
}

function effectLabel(value: ArtInspectorEffectKind): string {
  if (value === "shadow") {
    return "Shadow";
  }
  if (value === "glow") {
    return "Glow";
  }
  return "Sketch";
}

function lineJoinLabel(value: "miter" | "round" | "bevel"): string {
  if (value === "miter") {
    return "Sharp";
  }
  if (value === "round") {
    return "Round";
  }
  return "Bevel";
}

function artGradientRailCss(stops: readonly { offset: number; color: string; opacity: number }[]): string {
  const stopCss = stops
    .map((stop) => `${hexToRgbaCss(stop.color, stop.opacity)} ${Math.round(stop.offset * 100)}%`)
    .join(", ");
  return `linear-gradient(90deg, ${stopCss})`;
}

function nextInsertedGradientStopIndex(stops: readonly { offset: number }[]): number {
  if (stops.length <= 1) {
    return stops.length;
  }

  let leftIndex = 0;
  let widestGap = -1;
  for (let index = 0; index < stops.length - 1; index += 1) {
    const gap = stops[index + 1]!.offset - stops[index]!.offset;
    if (gap > widestGap) {
      widestGap = gap;
      leftIndex = index;
    }
  }

  return leftIndex + 1;
}

function hexToRgbaCss(color: string, opacity: number): string {
  const normalized = normalizeHexColor(color) ?? "#111111";
  const red = Number.parseInt(normalized.slice(1, 3), 16);
  const green = Number.parseInt(normalized.slice(3, 5), 16);
  const blue = Number.parseInt(normalized.slice(5, 7), 16);
  return `rgb(${red} ${green} ${blue} / ${Math.max(0, Math.min(1, opacity))})`;
}

type ColorPickerTab = "palette" | "mixer";
type ColorCommand = {
  id: string;
  title: string;
  color: string;
};

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
  colorCommands = textColorCommands,
  currentColor,
  customColorCommandId = textCustomColorCommandId,
  label = "Text color",
  triggerLabel = "Open text color picker",
  dialogLabel = "Text color picker",
  onOpenChange,
  onInvoke
}: {
  compact?: boolean;
  colorCommands?: readonly ColorCommand[];
  currentColor: string;
  customColorCommandId?: (color: string) => string;
  label?: string;
  triggerLabel?: string;
  dialogLabel?: string;
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
    onInvoke(customColorCommandId(normalized));
  };

  const applyPresetColor = (command: ColorCommand) => {
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
      aria-label={label}
      data-color-picker="true"
      data-palette-control="true"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="toolbar-color-trigger"
        aria-label={triggerLabel}
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
        <div className="toolbar-color-popover" role="dialog" aria-label={dialogLabel}>
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
                {colorCommands.map((command) => (
                  <ColorPresetSwatchButton
                    active={normalizeHexColor(command.color) === normalizedCurrentColor}
                    command={command}
                    key={command.id}
                    onApply={applyPresetColor}
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
  const invokeHandlers = usePaletteButtonInvoke(commandId, onInvoke);

  return (
    <button
      type="button"
      className={["toolbar-text-button", active ? "active" : ""].filter(Boolean).join(" ")}
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-command-id={commandId}
      data-palette-control="true"
      {...invokeHandlers}
    >
      {children}
    </button>
  );
}

function ToolbarColorSwatchButton({
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

function ColorPresetSwatchButton({
  active,
  command,
  onApply
}: {
  active: boolean;
  command: ColorCommand;
  onApply: (command: ColorCommand) => void;
}) {
  const invokeHandlers = usePaletteButtonInvoke(command.id, () => onApply(command));

  return (
    <button
      type="button"
      className={["color-preset-swatch", active ? "active" : ""].filter(Boolean).join(" ")}
      title={command.title}
      aria-label={command.title}
      aria-pressed={active}
      data-command-id={command.id}
      style={{ "--swatch-color": command.color } as CSSProperties}
      {...invokeHandlers}
    />
  );
}

function ToolbarAlignButton({
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

function usePaletteButtonInvoke(
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
  tooltipId,
  tooltipVisible,
  distributeMode = "centers",
  onTooltipEnter,
  onTooltipLeave,
  separated = false,
  onInvoke
}: {
  command: CommandSpec;
  active?: boolean;
  tooltipId?: string;
  tooltipVisible?: boolean;
  distributeMode?: ToolPaletteDistributeMode;
  onTooltipEnter?: () => void;
  onTooltipLeave?: () => void;
  separated?: boolean;
  onInvoke: (commandId: string) => void;
}) {
  const disabled = command.enabled === false;
  if (isDistributeCommandId(command.id)) {
    return (
      <DistributeCommandIconButton
        active={active}
        command={command}
        disabled={disabled}
        distributeMode={distributeMode}
        separated={separated}
        tooltipId={tooltipId}
        tooltipVisible={tooltipVisible}
        onInvoke={onInvoke}
        onTooltipEnter={onTooltipEnter}
        onTooltipLeave={onTooltipLeave}
      />
    );
  }

  const activeState = active && !disabled;
  const shortcut = command.shortcut ?? command.defaultShortcut;
  const shortcutLabel = command.shortcutLabel ?? shortcut;
  const visibleShortcutLabel = shortcutLabel ?? "No shortcut";
  const shortcutText = ` (${visibleShortcutLabel})`;
  const stateText = disabled ? `: ${command.disabledReason ?? "unavailable"}` : "";
  const tooltipText = `${command.title}${shortcutText}${stateText}`;
  const invokeHandlers = usePaletteButtonInvoke(command.id, onInvoke, disabled);

  return (
    <span
      className={["icon-button-shell", separated ? "separated" : ""].filter(Boolean).join(" ")}
      data-command-tooltip-owner={command.id}
      data-tooltip-owner-id={tooltipId}
      data-tooltip-visible={tooltipVisible ? "true" : undefined}
      onBlur={() => onTooltipLeave?.()}
      onClickCapture={() => onTooltipLeave?.()}
      onPointerCancel={() => onTooltipLeave?.()}
      onPointerDownCapture={() => onTooltipLeave?.()}
      onPointerEnter={() => onTooltipEnter?.()}
      onPointerLeave={() => onTooltipLeave?.()}
      onMouseEnter={() => onTooltipEnter?.()}
      onMouseLeave={() => onTooltipLeave?.()}
    >
      <button
        type="button"
        className={[
          "icon-button",
          activeState ? "active" : "",
          command.id === "structure.cleanup2d" ? "structure-cleanup-button" : ""
        ].filter(Boolean).join(" ")}
        aria-label={tooltipText}
        aria-pressed={activeState || undefined}
        disabled={disabled}
        data-active={activeState ? "true" : undefined}
        data-command-id={command.id}
        data-shortcut-label={visibleShortcutLabel}
        data-toolbar-asset={command.assetName}
        data-tooltip={tooltipText}
        {...invokeHandlers}
      >
        {command.assetName ? (
          <img className="tool-icon-image" src={toolbarAsset(command.assetName)} alt="" aria-hidden="true" />
        ) : command.id.startsWith("tool.art.") ? (
          <ArtToolIcon commandId={command.id} />
        ) : (
          <Icon name={command.icon} />
        )}
        <span className="tool-tooltip" id={tooltipId} aria-hidden="true">{tooltipText}</span>
      </button>
    </span>
  );
}

type ArtArrangeFlyout = {
  id: string;
  title: string;
  commands: CommandSpec[];
};

type ArtArrangeToolbarItem =
  | { kind: "flyout"; id: string; flyout: ArtArrangeFlyout }
  | { kind: "command"; id: string; command: CommandSpec };

function artArrangeToolbarItemsForGroup(group: CommandSpec[]): ArtArrangeToolbarItem[] {
  if (!group.some((command) => ART_ARRANGE_COMMAND_IDS.has(command.id))) {
    return [];
  }

  const commandById = new Map(group.map((command) => [command.id, command] as const));
  const flyoutById = new Map<string, ArtArrangeFlyout>(ART_ARRANGE_FLYOUTS.map((flyout) => [flyout.id, {
    id: flyout.id,
    title: flyout.title,
    commands: flyout.commandIds.flatMap((commandId) => {
      const command = commandById.get(commandId);
      return command ? [command] : [];
    })
  }] as const).filter(([, flyout]) => flyout.commands.length > 0));
  const items: ArtArrangeToolbarItem[] = [];
  const pushFlyout = (id: string) => {
    const flyout = flyoutById.get(id);
    if (flyout) {
      items.push({ kind: "flyout", id, flyout });
    }
  };

  pushFlyout("align");
  ART_ARRANGE_STANDALONE_COMMAND_IDS.forEach((commandId) => {
    const command = commandById.get(commandId);
    if (command) {
      items.push({ kind: "command", id: command.id, command });
    }
  });
  pushFlyout("layer");
  pushFlyout("transform");
  pushFlyout("group");

  return items;
}

function artShapeFlyoutForGroup(group: CommandSpec[]): ArtArrangeFlyout | undefined {
  if (!group.some((command) => ART_SHAPE_COMMAND_IDS.includes(command.id as typeof ART_SHAPE_COMMAND_IDS[number]))) {
    return undefined;
  }

  const commandById = new Map(group.map((command) => [command.id, command] as const));
  const commands = ART_SHAPE_COMMAND_IDS.flatMap((commandId) => {
    const command = commandById.get(commandId);
    return command ? [command] : [];
  });

  return commands.length > 0 ? { id: "shapes", title: "Shapes", commands } : undefined;
}

function CommandFlyoutButton({
  commands,
  distributeMode,
  title,
  primaryAssetName,
  activeCommandId,
  tooltipId,
  tooltipVisible,
  onTooltipEnter,
  onTooltipLeave,
  onInvoke
}: {
  commands: CommandSpec[];
  distributeMode: ToolPaletteDistributeMode;
  title: string;
  primaryAssetName?: ToolbarAssetName;
  activeCommandId?: string;
  tooltipId?: string;
  tooltipVisible?: boolean;
  onTooltipEnter?: () => void;
  onTooltipLeave?: () => void;
  onInvoke: (commandId: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const shellRef = useRef<HTMLSpanElement | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const holdOpenedRef = useRef(false);
  const primaryCommand = commands[0];
  const primaryDisabled = primaryCommand.enabled === false;
  const flyoutAssetName = primaryAssetName ?? primaryCommand.assetName;
  const activeState = commands.some((command) => command.enabled !== false && command.id === activeCommandId);
  const shortcut = primaryCommand.shortcut ?? primaryCommand.defaultShortcut;
  const shortcutLabel = primaryCommand.shortcutLabel ?? shortcut;
  const visibleShortcutLabel = shortcutLabel ?? "No shortcut";
  const shortcutText = ` (${visibleShortcutLabel})`;
  const stateText = primaryDisabled ? `: ${primaryCommand.disabledReason ?? "unavailable"}` : "";
  const distributeText = commands.some((command) => isDistributeCommandId(command.id))
    ? `: ${distributeMode === "spacing" ? "equal gaps" : "centers"}`
    : "";
  const tooltipText = `${title}${distributeText}: ${primaryCommand.title}; hold for choices${shortcutText}${stateText}`;

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current !== undefined) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = undefined;
    }
  }, []);

  const openMenu = useCallback(() => {
    holdOpenedRef.current = true;
    setMenuOpen(true);
    onTooltipLeave?.();
  }, [onTooltipLeave]);

  const chooseCommand = useCallback((command: CommandSpec) => {
    if (command.enabled === false) {
      return;
    }
    onInvoke(command.id);
    setMenuOpen(false);
    onTooltipLeave?.();
  }, [onInvoke, onTooltipLeave]);

  useEffect(() => () => {
    clearHoldTimer();
  }, [clearHoldTimer]);

  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && shellRef.current?.contains(target)) {
        return;
      }
      setMenuOpen(false);
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [menuOpen]);

  return (
    <span
      className="icon-button-shell command-flyout-shell"
      data-command-flyout={title.toLowerCase()}
      data-command-tooltip-owner={primaryCommand.id}
      data-tooltip-owner-id={tooltipId}
      data-tooltip-visible={tooltipVisible && !menuOpen ? "true" : undefined}
      ref={shellRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !menuOpen) {
          onTooltipLeave?.();
        }
      }}
      onClickCapture={() => onTooltipLeave?.()}
      onPointerCancel={() => onTooltipLeave?.()}
      onPointerDownCapture={() => onTooltipLeave?.()}
      onPointerEnter={() => onTooltipEnter?.()}
      onPointerLeave={() => onTooltipLeave?.()}
      onMouseEnter={() => onTooltipEnter?.()}
      onMouseLeave={() => onTooltipLeave?.()}
    >
      <button
        type="button"
        className={[
          "icon-button",
          "command-flyout-button",
          activeState ? "active" : ""
        ].filter(Boolean).join(" ")}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={tooltipText}
        aria-pressed={activeState || undefined}
        data-command-id={primaryCommand.id}
        data-active={activeState ? "true" : undefined}
        data-command-flyout-button={title.toLowerCase()}
        data-command-flyout-ids={commands.map((command) => command.id).join(" ")}
        data-disabled={primaryDisabled ? "true" : undefined}
        data-shortcut-label={visibleShortcutLabel}
        data-toolbar-asset={flyoutAssetName}
        data-tooltip={tooltipText}
        onPointerDown={(event) => {
          event.stopPropagation();
          if (event.button !== 0) {
            return;
          }
          holdOpenedRef.current = false;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          clearHoldTimer();
          holdTimerRef.current = setTimeout(openMenu, COMMAND_FLYOUT_HOLD_MS);
        }}
        onPointerUp={(event) => {
          event.stopPropagation();
          clearHoldTimer();
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          if (primaryDisabled || holdOpenedRef.current || menuOpen) {
            return;
          }
          onInvoke(primaryCommand.id);
        }}
        onPointerCancel={(event) => {
          event.stopPropagation();
          clearHoldTimer();
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            openMenu();
            return;
          }
          if ((event.key === "Enter" || event.key === " ") && !primaryDisabled) {
            event.preventDefault();
            onInvoke(primaryCommand.id);
          }
        }}
      >
        {flyoutAssetName ? (
          <img className="tool-icon-image" src={toolbarAsset(flyoutAssetName)} alt="" aria-hidden="true" />
        ) : (
          <Icon name={primaryCommand.icon} />
        )}
        <span className="command-flyout-indicator" aria-hidden="true" />
        <span className="tool-tooltip" id={tooltipId} aria-hidden="true">{tooltipText}</span>
      </button>
      <div
        className="toolbar-command-flyout-menu"
        role="menu"
        aria-label={`${title} commands`}
        data-command-flyout-menu={title.toLowerCase()}
        hidden={!menuOpen}
      >
        {commands.map((command) => {
          const disabled = command.enabled === false;
          const itemShortcut = command.shortcutLabel ?? command.shortcut ?? command.defaultShortcut;
          const itemText = disabled
            ? `${command.title}: ${command.disabledReason ?? "unavailable"}`
            : command.title;
          return (
            <button
              type="button"
              role="menuitem"
              disabled={disabled}
              data-command-id={command.id}
              data-shortcut-label={itemShortcut ?? "No shortcut"}
              data-toolbar-asset={command.assetName}
              data-tooltip={itemText}
              key={command.id}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                chooseCommand(command);
              }}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                chooseCommand(command);
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                chooseCommand(command);
              }}
            >
              {command.assetName ? (
                <img className="tool-icon-image" src={toolbarAsset(command.assetName)} alt="" aria-hidden="true" />
              ) : (
                <Icon name={command.icon} />
              )}
              <span>{command.title}</span>
            </button>
          );
        })}
      </div>
    </span>
  );
}

function DistributeCommandIconButton({
  command,
  active,
  disabled,
  distributeMode,
  tooltipId,
  tooltipVisible,
  onTooltipEnter,
  onTooltipLeave,
  separated,
  onInvoke
}: {
  command: CommandSpec;
  active: boolean;
  disabled: boolean;
  distributeMode: ToolPaletteDistributeMode;
  tooltipId?: string;
  tooltipVisible?: boolean;
  onTooltipEnter?: () => void;
  onTooltipLeave?: () => void;
  separated?: boolean;
  onInvoke: (commandId: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const shellRef = useRef<HTMLSpanElement | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const holdOpenedRef = useRef(false);
  const activeState = active && !disabled;
  const shortcut = command.shortcut ?? command.defaultShortcut;
  const shortcutLabel = command.shortcutLabel ?? shortcut;
  const visibleShortcutLabel = shortcutLabel ?? "No shortcut";
  const modeLabel = distributeMode === "spacing" ? "equal gaps" : "centers";
  const shortcutText = ` (${visibleShortcutLabel})`;
  const stateText = disabled ? `: ${command.disabledReason ?? "unavailable"}` : "";
  const tooltipText = `${command.title}: ${modeLabel}${shortcutText}${stateText}`;

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current !== undefined) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = undefined;
    }
  }, []);

  const openMenu = useCallback(() => {
    holdOpenedRef.current = true;
    setMenuOpen(true);
    onTooltipLeave?.();
  }, [onTooltipLeave]);

  const chooseMode = useCallback((commandId: string) => {
    onInvoke(commandId);
    setMenuOpen(false);
    onTooltipLeave?.();
  }, [onInvoke, onTooltipLeave]);

  useEffect(() => () => {
    clearHoldTimer();
  }, [clearHoldTimer]);

  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && shellRef.current?.contains(target)) {
        return;
      }
      setMenuOpen(false);
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [menuOpen]);

  return (
    <span
      className={["icon-button-shell", "distribute-button-shell", separated ? "separated" : ""].filter(Boolean).join(" ")}
      data-command-tooltip-owner={command.id}
      data-distribute-menu-open={menuOpen ? "true" : undefined}
      data-tooltip-owner-id={tooltipId}
      data-tooltip-visible={tooltipVisible && !menuOpen ? "true" : undefined}
      ref={shellRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !menuOpen) {
          onTooltipLeave?.();
        }
      }}
      onClickCapture={() => onTooltipLeave?.()}
      onPointerCancel={() => onTooltipLeave?.()}
      onPointerDownCapture={() => onTooltipLeave?.()}
      onPointerEnter={() => onTooltipEnter?.()}
      onPointerLeave={() => onTooltipLeave?.()}
      onMouseEnter={() => onTooltipEnter?.()}
      onMouseLeave={() => onTooltipLeave?.()}
    >
      <button
        type="button"
        className={["icon-button", "distribute-mode-button", activeState ? "active" : ""].filter(Boolean).join(" ")}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={tooltipText}
        aria-pressed={activeState || undefined}
        data-active={activeState ? "true" : undefined}
        data-command-id={command.id}
        data-disabled={disabled ? "true" : undefined}
        data-distribute-mode={distributeMode}
        data-shortcut-label={visibleShortcutLabel}
        data-toolbar-asset={command.assetName}
        data-tooltip={tooltipText}
        onPointerDown={(event) => {
          event.stopPropagation();
          if (event.button !== 0) {
            return;
          }
          holdOpenedRef.current = false;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          clearHoldTimer();
          holdTimerRef.current = setTimeout(openMenu, DISTRIBUTE_MENU_HOLD_MS);
        }}
        onPointerUp={(event) => {
          event.stopPropagation();
          clearHoldTimer();
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          if (disabled || holdOpenedRef.current || menuOpen) {
            return;
          }
          onInvoke(command.id);
        }}
        onPointerCancel={(event) => {
          event.stopPropagation();
          clearHoldTimer();
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            openMenu();
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onInvoke(command.id);
          }
        }}
      >
        {command.assetName ? (
          <img className="tool-icon-image" src={toolbarAsset(command.assetName)} alt="" aria-hidden="true" />
        ) : (
          <Icon name={command.icon} />
        )}
        <span className="distribute-mode-indicator" data-distribute-mode={distributeMode} aria-hidden="true">
          <span />
          <span />
        </span>
        <span className="tool-tooltip" id={tooltipId} aria-hidden="true">{tooltipText}</span>
      </button>
      {menuOpen ? (
        <div className="toolbar-distribute-menu" role="menu" aria-label="Distribute mode">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={distributeMode === "centers"}
            data-command-id={distributeModeCommandIds.centers}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              chooseMode(distributeModeCommandIds.centers);
            }}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              chooseMode(distributeModeCommandIds.centers);
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              chooseMode(distributeModeCommandIds.centers);
            }}
          >
            Centers
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={distributeMode === "spacing"}
            data-command-id={distributeModeCommandIds.spacing}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              chooseMode(distributeModeCommandIds.spacing);
            }}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              chooseMode(distributeModeCommandIds.spacing);
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              chooseMode(distributeModeCommandIds.spacing);
            }}
          >
            Equal gaps
          </button>
        </div>
      ) : null}
    </span>
  );
}

function isDistributeCommandId(commandId: string): boolean {
  return commandId === "layout.distributeHorizontal" || commandId === "layout.distributeVertical";
}

function ArtToolIcon({ commandId }: { commandId: string }) {
  const toolId = commandId.replace(/^tool\.art\./, "");
  const dashed = toolId.includes("Dashed");
  const filled = toolId.includes("Filled") || toolId.includes("Gloss");
  const gloss = toolId.includes("Gloss");
  const shadow = toolId.includes("Shadow");
  const strokeClass = ["art-tool-stroke", dashed ? "dashed" : "", filled ? "filled" : ""].filter(Boolean).join(" ");
  const shadowElement = shadow ? <path className="art-tool-shadow" d={artToolShapePath(toolId)} aria-hidden="true" /> : null;

  if (toolId === "pencil") {
    return (
      <svg className="art-tool-icon" viewBox="0 0 17 17" aria-hidden="true" focusable="false" data-art-tool-icon={toolId}>
        <g data-art-freehand-glyph="pencil">
          <path className="art-tool-stroke" d="M3 14 L4.2 10.4 L11.2 3.4 C11.9 2.7 12.9 2.7 13.6 3.4 C14.3 4.1 14.3 5.1 13.6 5.8 L6.6 12.8 Z" />
          <path className="art-tool-stroke filled" d="M3 14 L4.2 10.4 L6.6 12.8 Z" />
          <path className="art-tool-stroke" d="M10.4 4.2 L12.8 6.6" />
        </g>
      </svg>
    );
  }

  if (toolId === "brush") {
    return (
      <svg className="art-tool-icon" viewBox="0 0 17 17" aria-hidden="true" focusable="false" data-art-tool-icon={toolId}>
        <g data-art-freehand-glyph="brush">
          <path className="art-tool-stroke" d="M10.3 8.3 L13.9 4.7 C14.4 4.2 14.4 3.5 13.9 3 C13.4 2.5 12.7 2.5 12.2 3 L8.6 6.6" />
          <path className="art-tool-stroke filled" d="M5.1 13.9 C5.8 12.1 4.3 11.1 6.5 8.7 C7.7 7.4 9.2 6.6 10.7 7 L10 10.8 C8.4 12.5 6.9 13.3 5.1 13.9 Z" />
          <path className="art-tool-stroke bold" d="M2.6 13.4 C4.2 11.1 6.4 14.5 8.9 11.7" />
        </g>
      </svg>
    );
  }

  if (toolId === "eyedropper") {
    return (
      <svg className="art-tool-icon" viewBox="0 0 17 17" aria-hidden="true" focusable="false" data-art-tool-icon={toolId}>
        <path className="art-tool-stroke" d="M11.5 2.4 L14.6 5.5 L6.7 13.4 L3.6 14.3 L4.5 11.2 Z" />
        <path className="art-tool-stroke filled" d="M4.5 11.2 L6.7 13.4 L3.6 14.3 Z" />
        <path className="art-tool-stroke" d="M9.8 4.1 L12.9 7.2" />
      </svg>
    );
  }

  if (toolId.startsWith("line")) {
    const path = toolId === "lineWavy"
      ? "M2 9 C4 4, 6 14, 8.5 9 S13 4, 15 9"
      : "M3 3 L14 14";
    return (
      <svg className="art-tool-icon" viewBox="0 0 17 17" aria-hidden="true" focusable="false" data-art-tool-icon={toolId}>
        <path
          className={["art-tool-stroke", dashed ? "dashed" : "", toolId === "lineBold" ? "bold" : ""].filter(Boolean).join(" ")}
          d={path}
        />
      </svg>
    );
  }

  if (toolId === "polyline") {
    return (
      <svg className="art-tool-icon" viewBox="0 0 17 17" aria-hidden="true" focusable="false" data-art-tool-icon={toolId}>
        <path className="art-tool-stroke" d="M2.5 12.5 L7 4.5 L14.5 9.5" />
      </svg>
    );
  }

  if (toolId === "pen") {
    return (
      <svg className="art-tool-icon" viewBox="0 0 17 17" aria-hidden="true" focusable="false" data-art-tool-icon={toolId}>
        <path className="art-tool-stroke" d="M2.6 12.4 C5.4 4.2 10.8 3.4 14.4 8.4" />
        <path className="art-tool-stroke filled" d="M2.3 12.7 L4.5 11.9 L3.1 10.5 Z" />
        <circle className="art-tool-stroke" cx="8.3" cy="5.7" r="1" />
      </svg>
    );
  }

  if (toolId === "arrow") {
    return (
      <svg className="art-tool-icon" viewBox="0 0 17 17" aria-hidden="true" focusable="false" data-art-tool-icon={toolId}>
        <path className="art-tool-stroke" d="M3 11 L13 5" />
        <path className="art-tool-stroke filled" d="M13 5 L10.2 5.2 L11.7 7.6 Z" />
      </svg>
    );
  }

  if (toolId.startsWith("arc")) {
    return (
      <svg className="art-tool-icon" viewBox="0 0 17 17" aria-hidden="true" focusable="false" data-art-tool-icon={toolId}>
        <path className={["art-tool-stroke", dashed ? "dashed" : ""].filter(Boolean).join(" ")} d={artToolArcPath(toolId)} />
      </svg>
    );
  }

  return (
    <svg className="art-tool-icon" viewBox="0 0 17 17" aria-hidden="true" focusable="false" data-art-tool-icon={toolId}>
      {shadowElement}
      <path className={strokeClass} d={artToolShapePath(toolId)} />
      {gloss ? <path className="art-tool-gloss" d={artToolGlossPath(toolId)} /> : null}
    </svg>
  );
}

function artToolShapePath(toolId: string): string {
  if (toolId.startsWith("circle")) {
    return "M8.5 2.2 A6.3 6.3 0 1 1 8.45 2.2 Z";
  }

  if (toolId.startsWith("ellipse")) {
    return "M2 8.5 A6.5 3.7 0 1 1 15 8.5 A6.5 3.7 0 1 1 2 8.5 Z";
  }

  if (toolId.startsWith("roundedRect")) {
    return "M4.1 3 H12.9 Q14 3 14 4.1 V12.9 Q14 14 12.9 14 H4.1 Q3 14 3 12.9 V4.1 Q3 3 4.1 3 Z";
  }

  return "M3 4 H14 V13 H3 Z";
}

function artToolGlossPath(toolId: string): string {
  if (toolId.startsWith("circle")) {
    return "M5.2 5.2 C6.1 4.2, 7.6 3.7, 9.2 4";
  }

  if (toolId.startsWith("ellipse")) {
    return "M4.5 7.1 C6.5 5.8, 10.3 5.8, 12.5 7.1";
  }

  return "M5 5.2 H12";
}

function artToolArcPath(toolId: string): string {
  if (toolId.startsWith("arc270")) {
    return "M8.5 2.2 A6.3 6.3 0 1 1 2.2 8.5";
  }

  if (toolId.startsWith("arc180")) {
    return "M2.4 8.5 A6.1 6.1 0 0 1 14.6 8.5";
  }

  if (toolId.startsWith("arc120")) {
    return "M4 10.6 A5.9 5.9 0 0 1 13 5.6";
  }

  return "M5.2 11.8 A6 6 0 0 1 11.8 5.2";
}
