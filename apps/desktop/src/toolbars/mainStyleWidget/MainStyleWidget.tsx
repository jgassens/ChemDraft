import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useToolbarWidgetState, type ToolbarWidgetState } from "../toolbarWidgets";
import { toolbarVariantForKind, type ToolbarStyleVariant } from "../toolbarSelectionKind";
import { StyleCellView, type MainStyleRows, type StyleCell } from "./cells";
import { textVariantRows } from "./TextVariant";
import { moleculeVariantRows } from "./MoleculeVariant";
import { shapeVariantRows } from "./ShapeVariant";

type VariantRowsBuilder = (state: ToolbarWidgetState) => MainStyleRows;

/** Layout builders by variant. A variant without a builder yet renders the text layout (and reports
 *  itself as text), so the widget stays shippable while variants land one at a time. */
const VARIANT_ROW_BUILDERS: Partial<Record<ToolbarStyleVariant, VariantRowsBuilder>> = {
  text: textVariantRows,
  molecule: moleculeVariantRows,
  shape: shapeVariantRows
};

export function mainStyleRowsForVariant(
  variant: ToolbarStyleVariant,
  state: ToolbarWidgetState
): { effectiveVariant: ToolbarStyleVariant; rows: MainStyleRows } {
  const builder = VARIANT_ROW_BUILDERS[variant];
  return builder
    ? { effectiveVariant: variant, rows: builder(state) }
    : { effectiveVariant: "text", rows: textVariantRows(state) };
}

/**
 * The Main Toolbar's selection-aware style widget: one grid slot, one 308×52 footprint, four
 * layouts (text / molecule / arrow / shape) chosen by the selection classifier. Empty, mixed, and
 * unclassified selections render the text layout — exactly the pre-variant widget.
 */
export function MainStyleWidget() {
  const widgetState = useToolbarWidgetState();
  // In customize mode the widget pins to the text layout: the user is arranging the toolbar, and
  // should lay it out against the default look rather than whatever happens to be selected.
  const targetVariant: ToolbarStyleVariant = widgetState.customizing
    ? "text"
    : toolbarVariantForKind(widgetState.currentSelection?.kind ?? "none");

  // Variant swaps are latched while a pointer gesture is in flight inside the widget: swapping
  // layouts mid-press would unmount the control under the pointer and silently drop its commit.
  // The latch opens on pointerdown and closes on the next window-level pointerup.
  const [renderedVariant, setRenderedVariant] = useState(targetVariant);
  const interactingRef = useRef(false);
  const targetVariantRef = useRef(targetVariant);
  targetVariantRef.current = targetVariant;

  useEffect(() => {
    if (!interactingRef.current) {
      setRenderedVariant((previous) => (previous === targetVariant ? previous : targetVariant));
    }
  }, [targetVariant]);

  const endInteraction = useCallback(() => {
    interactingRef.current = false;
    setRenderedVariant((previous) => (
      previous === targetVariantRef.current ? previous : targetVariantRef.current
    ));
  }, []);

  const beginInteraction = useCallback(() => {
    if (!interactingRef.current) {
      interactingRef.current = true;
      window.addEventListener("pointerup", endInteraction, { capture: true, once: true });
    }
  }, [endInteraction]);

  useEffect(() => () => {
    window.removeEventListener("pointerup", endInteraction, { capture: true });
  }, [endInteraction]);

  const { effectiveVariant, rows } = mainStyleRowsForVariant(renderedVariant, widgetState);

  const renderRow = (cells: readonly StyleCell[]) => cells.map((cell, index) => (
    <Fragment key={index}>
      <StyleCellView cell={cell} onInvoke={widgetState.onInvoke} />
    </Fragment>
  ));

  return (
    <div
      className="main-toolbar-style-controls"
      data-toolbar-style-controls="main"
      data-main-style-variant={effectiveVariant}
      onPointerDownCapture={beginInteraction}
    >
      <div className="toolbar-style-row toolbar-style-row-primary">{renderRow(rows.primary)}</div>
      <div className="toolbar-style-row toolbar-style-row-secondary">{renderRow(rows.secondary)}</div>
    </div>
  );
}
