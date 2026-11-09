import type { CSSProperties } from "react";
import { customSwatchCommandId, type CustomSwatchNumber, type CustomSwatchSlot } from "../customColorSwatches";
import { useCustomSwatches } from "./customSwatchSettings";
import { usePaletteButtonInvoke } from "./toolbarCells";
import { useToolbarWidgetState } from "./toolbarWidgets";

export function CustomColorSwatchWidget({ swatch }: { swatch: CustomSwatchNumber }) {
  const colors = useCustomSwatches()[swatch];
  return <div className="custom-color-swatch-widget" role="group" aria-label={`Custom Color Swatch ${swatch}`}>
    {([1, 2] as const).map(slot => <Slot key={slot} swatch={swatch} slot={slot} color={colors[`slot${slot}`]} />)}
  </div>;
}

function Slot({ swatch, slot, color }: { swatch: CustomSwatchNumber; slot: CustomSwatchSlot; color?: string }) {
  const { onInvoke, commandSpecs } = useToolbarWidgetState();
  const commandId = customSwatchCommandId(swatch, slot, color ? "apply" : "edit");
  const edit = customSwatchCommandId(swatch, slot, "edit");
  const spec = commandSpecs?.find(command => command.id === commandId);
  const disabled = spec?.enabled === false;
  const handlers = usePaletteButtonInvoke(commandId, onInvoke, disabled);
  const label = `Custom color ${swatch}, slot ${slot}: ${color ?? "empty. Click to set."}`;
  // aria-disabled keeps a set slot focusable for its always-available keyboard/context edit.
  return <button type="button" className="toolbar-color-swatch custom-color-slot" aria-label={label}
    aria-disabled={disabled || undefined} title={spec?.disabledReason ?? label} data-command-id={commandId} data-palette-control="true"
    style={{ "--swatch-color": color ?? "var(--cd-bg-control)" } as CSSProperties} {...handlers}
    onPointerDown={event => { if (event.button === 0) event.preventDefault(); handlers.onPointerDown(event); }}
    onMouseDown={event => { if (event.button === 0) event.preventDefault(); handlers.onMouseDown(event); }}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onInvoke(edit); }}
    onKeyDown={event => {
      if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") {
        event.preventDefault(); event.stopPropagation(); onInvoke(edit);
      }
    }}>{color ? null : "?"}</button>;
}
