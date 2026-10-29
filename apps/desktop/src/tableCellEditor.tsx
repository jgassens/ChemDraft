import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState,
  type CSSProperties, type ReactNode } from "react";
import { TABLE_LIMITS, nativeTextStyleFromObjectStyle,
  type ChemDraftDocument, type TableObject, type TableRichText, type TextObject, type TextSpan } from "@chemdraft/chem-core";
import { measureTextRun, planTableLayout } from "@chemdraft/layout-engine";
import { setTableColumnWidth } from "@chemdraft/document-workflow-core";
import { textScriptForCommand, textStylePatchForCommand } from "./commands";
import { symbolGlyphForToolCommand, updateNativeTextObjectText,
  updateNativeTextObjectScriptRange, updateNativeTextObjectStyleRange } from "./documentWorkflow";
import { detectDesktopShortcutPlatform, isBrowserReloadChord } from "./keyboardShortcuts";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { tableValidationMessage, type ActiveTableText } from "./tableCommands";
import { tableEditingContent, tableEditingKeyAction, type TableEditingAction } from "./tableInteraction";

export interface TableCellEditorHandle {
  applyCommand(commandId: string): boolean;
  commit(): true | false | "composing";
}

/** Like native text objects: a textarea owns input/IME, and the shared rich-text view paints runs. */
export const TableCellEditor = forwardRef<TableCellEditorHandle, {
  document: ChemDraftDocument;
  table: TableObject;
  cell: ActiveTableText;
  scale: number;
  platform?: ShortcutPlatform;
  renderText(object: TextObject): ReactNode;
  resolveShortcut(event: KeyboardEvent): string | undefined;
  onFinish(value: TableRichText, action: TableEditingAction): void;
  onHistoryCommand(direction: "undo" | "redo"): void;
  onError(message: string): void;
}>(function TableCellEditor({ document: nativeDocument, table, cell, scale, platform = detectDesktopShortcutPlatform(),
  renderText, resolveShortcut, onFinish, onHistoryCommand, onError }, ref) {
  const isNote = "kind" in cell;
  const row = isNote ? -1 : table.rows.findIndex(item => item.id === cell.rowId);
  const column = isNote ? -1 : table.columns.findIndex(item => item.id === cell.columnId);
  const { box, value } = tableEditingContent(table, cell)!;
  const editorLabel = isNote ? cell.kind === "caption" ? "Table caption" : "Table footnote" : "Table cell";
  const [draft, setDraft] = useState<TextObject>(() => ({ type: "text", id: "table-cell-draft",
    x: box.x, y: box.y, width: box.width, height: box.height, rotation: 0,
    style: { ...table.style, ...(isNote ? {
      fontSizePx: nativeTextStyleFromObjectStyle(table.style).fontSizePx * 0.9
    } : {}) }, text: value.text, spans: value.spans }));
  const draftRef = useRef(draft);
  const initialValue = useRef(draft);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const closed = useRef(false);
  const composing = useRef(false);
  const deferredOutside = useRef(false);
  const compositionCommitTimer = useRef<number | undefined>(undefined);
  const selection = useRef({ start: draft.text.length, end: draft.text.length });
  const emptyFormat = useRef<TextSpan>({ text: "", script: "normal", style: {} });
  const finishRef = useRef(onFinish); finishRef.current = onFinish;

  const scratchFor = (object: TextObject): ChemDraftDocument => ({ ...nativeDocument,
    pages: [{ ...nativeDocument.pages[0], objects: [object] }],
    selection: { pageId: nativeDocument.pages[0].id, objectIds: [object.id] } });
  const isUnchanged = () => {
    if (draftRef.current.text !== initialValue.current.text) return false;
    // The shared text edit normalizes empty/plain spans and adjacent identical runs. Reverted
    // typing must not create history merely because [] became one explicit normal span.
    const normalizedSpans = (object: TextObject) =>
      (updateNativeTextObjectText(scratchFor(object), object.id, object.text).pages[0].objects[0] as TextObject).spans;
    return JSON.stringify(normalizedSpans(draftRef.current)) === JSON.stringify(normalizedSpans(initialValue.current));
  };

  const finish = (action: TableEditingAction) => {
    if (closed.current) return true;
    try {
      const value = isUnchanged() ? initialValue.current : draftRef.current;
      finishRef.current({ text: value.text, spans: value.spans }, action);
      closed.current = true;
      return true;
    } catch (error) {
      onError(tableValidationMessage(error));
      editorRef.current?.focus({ preventScroll: true });
      return false;
    }
  };
  const finishLatest = useRef(finish); finishLatest.current = finish;
  // Run the very same text-object operations against a private scratch document. Drafts never
  // enter the real document or history; the only persisted model is native TextSpan[].
  const update = (edit: (scratch: ChemDraftDocument, id: string) => ChemDraftDocument) => {
    const object = draftRef.current;
    const next = edit(scratchFor(object), object.id).pages[0].objects[0] as TextObject;
    draftRef.current = next; setDraft(next);
  };
  const recordSelection = () => {
    const editor = editorRef.current;
    if (editor) selection.current = { start: editor.selectionStart, end: editor.selectionEnd };
  };
  const changeText = (text: string) => {
    const wasEmpty = draftRef.current.text.length === 0;
    update((scratch, id) => {
      let next = updateNativeTextObjectText(scratch, id, text);
      if (wasEmpty && text.length) {
        const range = { start: 0, end: text.length };
        if (emptyFormat.current.script !== "normal") {
          next = updateNativeTextObjectScriptRange(next, id, range, emptyFormat.current.script);
        }
        if (Object.keys(emptyFormat.current.style).length) {
          next = updateNativeTextObjectStyleRange(next, id, range, emptyFormat.current.style);
        }
      }
      return next;
    });
    if (text.length) emptyFormat.current = { text: "", script: "normal", style: {} };
  };
  const insert = (text: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    const { start, end } = selection.current;
    const value = draftRef.current.text;
    const next = value.slice(0, start) + text + value.slice(end);
    if (next.length > TABLE_LIMITS.maxCellCharacters) {
      onError(`Table cells are limited to ${TABLE_LIMITS.maxCellCharacters} characters.`); return;
    }
    changeText(next);
    const offset = start + text.length;
    selection.current = { start: offset, end: offset };
    // React has to install the controlled value before restoring the caret.
    queueMicrotask(() => { editor.focus({ preventScroll: true }); editor.setSelectionRange(offset, offset); });
  };
  const applyCommand = (commandId: string) => {
    if (window.document.activeElement === editorRef.current) recordSelection();
    if ((commandId === "edit.undo" || commandId === "edit.redo") && isUnchanged()) {
      // A freshly reached cell has no typing to undo. Undo the previous commit (formula first),
      // while a dirty textarea retains its native typing history.
      onHistoryCommand(commandId === "edit.undo" ? "undo" : "redo"); return true;
    }
    const glyph = symbolGlyphForToolCommand(commandId);
    if (glyph) { insert(glyph); return true; }
    const object = draftRef.current;
    const range = selection.current.start === selection.current.end
      ? { start: 0, end: object.text.length } : selection.current;
    let offset = 0;
    const runs = object.spans.filter(span => {
      const start = offset; offset += span.text.length;
      return offset > range.start && start < range.end;
    });
    const script = textScriptForCommand(commandId);
    const style = nativeTextStyleFromObjectStyle({ ...object.style, ...(object.text ? runs[0]?.style : emptyFormat.current.style) });
    const patch = textStylePatchForCommand(commandId, style);
    if (!script && !patch) return false;
    if (!object.text) {
      if (script) emptyFormat.current = { ...emptyFormat.current,
        script: emptyFormat.current.script === script ? "normal" : script };
      else emptyFormat.current = { ...emptyFormat.current, style: { ...emptyFormat.current.style, ...patch } };
      editorRef.current?.focus({ preventScroll: true });
      return true;
    }
    if (script) {
      const next = script !== "normal" && runs.length && runs.every(run => run.script === script) ? "normal" : script;
      update((scratch, id) => updateNativeTextObjectScriptRange(scratch, id, range, next));
    } else if (patch) {
      update((scratch, id) => updateNativeTextObjectStyleRange(scratch, id, range, patch));
    }
    editorRef.current?.focus({ preventScroll: true });
    return true;
  };
  useImperativeHandle(ref, () => ({ applyCommand, commit: () => {
    if (composing.current) return "composing";
    return finish({ kind: "commit" });
  } }));
  useLayoutEffect(() => {
    const editor = editorRef.current!;
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }, []);
  useEffect(() => {
    const outside = (event: globalThis.PointerEvent) => {
      if (editorRef.current?.parentElement?.contains(event.target as Node)) return;
      if (composing.current) {
        deferredOutside.current = true; event.preventDefault(); event.stopImmediatePropagation(); return;
      }
      finishLatest.current({ kind: "commit" });
    };
    window.document.addEventListener("pointerdown", outside, true);
    return () => {
      window.document.removeEventListener("pointerdown", outside, true);
      window.clearTimeout(compositionCommitTimer.current);
    };
  }, []);

  const textStyle = nativeTextStyleFromObjectStyle(draft.style);
  const padding = isNote ? { x: 0, y: 0 } : table.tableStyle.cellPaddingPx;
  const headerBold = !isNote && row < table.headerRowCount && table.tableStyle.headerBold;
  const baseWeight = headerBold ? Math.max(700, textStyle.fontWeight) : textStyle.fontWeight;
  const lines = draft.text.split(/\r?\n/);
  const widths = [0];
  const spans: TextSpan[] = draft.spans.map(span => span.text).join("") === draft.text && draft.spans.length
    ? draft.spans : [{ text: draft.text, script: "normal" as const, style: {} }];
  for (const span of spans) {
    span.text.split(/\r?\n/).forEach((text, index) => {
      if (index) widths.push(0);
      const size = span.script === "normal" && typeof span.style.fontSizePx === "number"
        ? span.style.fontSizePx : textStyle.fontSizePx;
      const weight = headerBold ? Math.max(700, span.style.fontWeight ?? 700)
        : span.style.fontWeight ?? textStyle.fontWeight;
      const spacing = span.style.letterSpacingPx ?? textStyle.letterSpacingPx;
      widths[widths.length - 1] += measureTextRun(text, { fontSizePx: size, fontWeight: weight, script: span.script })
        + [...text].length * spacing;
    });
  }
  // The textarea's unformatted text also needs room for its caret and native selection.
  const plainWidths = lines.map(line => measureTextRun(line, { fontSizePx: textStyle.fontSizePx, fontWeight: baseWeight })
    + [...line].length * textStyle.letterSpacingPx);
  const width = Math.max(box.width, Math.max(0, ...widths, ...plainWidths) + 2 * padding.x + (draft.text ? 1 : 0));
  const height = Math.max(box.height, lines.length * textStyle.fontSizePx * textStyle.lineHeight + 2 * padding.y);
  const textCss: CSSProperties = { fontFamily: textStyle.fontFamily, fontSize: textStyle.fontSizePx * scale,
    fontWeight: baseWeight,
    fontStyle: textStyle.fontStyle, color: textStyle.color, lineHeight: textStyle.lineHeight,
    textDecoration: textStyle.textDecoration, letterSpacing: textStyle.letterSpacingPx * scale,
    textAlign: isNote ? "left" : table.columns[column].align === "right" ? "right"
      : ["center", "decimal"].includes(table.columns[column].align) ? "center" : "left" };
  return <div data-table-cell-editor={table.id} data-row-id={isNote ? undefined : cell.rowId}
    data-column-id={isNote ? undefined : cell.columnId}
    style={{ position: "absolute", left: box.x * scale, top: box.y * scale, width: width * scale,
      height: height * scale, transform: `rotate(${table.rotation}deg)`,
      transformOrigin: `${(table.x + table.width / 2 - box.x) * scale}px ${(table.y + table.height / 2 - box.y) * scale}px`,
      pointerEvents: "auto", zIndex: 4, background: "var(--cd-bg-page, white)", ...textCss }}
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <div style={{ position: "absolute", left: padding.x * scale, right: padding.x * scale,
      top: padding.y * scale, bottom: padding.y * scale, overflow: "hidden", whiteSpace: "pre", pointerEvents: "none" }}>
      <div ref={previewRef} data-table-cell-preview>{renderText(draft)}</div>
    </div>
    <textarea ref={editorRef} aria-label={editorLabel} spellCheck={false} wrap="off"
      maxLength={TABLE_LIMITS.maxCellCharacters} value={draft.text}
      style={{ ...textCss, position: "absolute", inset: 0, width: "100%", height: "100%", boxSizing: "border-box",
        border: 0, outline: "1px solid var(--cd-accent, #1d7f68)", borderRadius: 0, resize: "none",
        padding: `${padding.y * scale}px ${padding.x * scale}px`, margin: 0,
        background: "transparent", color: "transparent", caretColor: textStyle.color, overflow: "auto" }}
      onChange={event => {
        recordSelection();
        changeText(event.currentTarget.value);
      }}
      onSelect={recordSelection} onKeyUp={recordSelection} onPointerUp={recordSelection}
      onScroll={event => {
        if (previewRef.current) previewRef.current.style.transform =
          `translate(${-event.currentTarget.scrollLeft}px, ${-event.currentTarget.scrollTop}px)`;
      }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => {
        composing.current = false;
        if (deferredOutside.current) {
          deferredOutside.current = false;
          // WebKit may deliver the final input after compositionend. Let it update the draft first.
          compositionCommitTimer.current = window.setTimeout(() => finishLatest.current({ kind: "commit" }), 0);
        }
      }}
      onPaste={event => {
        event.preventDefault(); event.stopPropagation(); recordSelection();
        insert(event.clipboardData.getData("text/plain"));
      }}
      onBlur={() => {
        // Native floating palettes keep the draft open; a DOM focus move inside this window commits.
        if (window.document.hasFocus() && !composing.current) finish({ kind: "commit" });
      }}
      onKeyDown={event => {
        event.stopPropagation();
        if (isBrowserReloadChord(event, platform) || event.key === "F5") { event.preventDefault(); return; }
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        recordSelection();
        const command = resolveShortcut(event.nativeEvent);
        const commandKey = platform === "macos" ? event.metaKey : event.ctrlKey;
        const fallback = commandKey && !event.altKey ? ({ b: "text.bold", i: "text.italic",
          "=": event.shiftKey ? "text.script.superscript" : "text.script.subscript", "+": "text.script.superscript" } as Record<string, string>)[event.key.toLowerCase()] : undefined;
        if ((command && applyCommand(command)) || (fallback && applyCommand(fallback))) {
          event.preventDefault(); return;
        }
        const action = tableEditingKeyAction(table, cell, event.nativeEvent, draftRef.current.text,
          event.currentTarget.selectionStart, event.currentTarget.selectionEnd);
        if (action.kind === "caret") {
          if (commandKey && event.key.toLowerCase() === "a") { event.preventDefault(); event.currentTarget.select(); recordSelection(); }
          return;
        }
        event.preventDefault();
        if (action.kind === "lineBreak") insert("\n"); else finish(action);
      }} />
  </div>;
});

/** Six screen pixels wide regardless of zoom; the handle follows the same stored pivot as SVG. */
export function TableColumnResizers({ table, scale, onPreview, onCommit }: {
  table: TableObject; scale: number;
  onPreview(table: TableObject | undefined): void;
  onCommit(table: TableObject, label: string): void;
}) {
  const drag = useRef<{ pointerId: number; x: number; y: number; width: number; columnId: string;
    table: TableObject; px?: number; latest?: TableObject } | undefined>(undefined);
  const previewFrame = useRef<number | undefined>(undefined);
  const cancelPreviewFrame = () => {
    if (previewFrame.current !== undefined) window.cancelAnimationFrame(previewFrame.current);
    previewFrame.current = undefined;
  };
  const latest = useRef({ onPreview, onCommit }); latest.current = { onPreview, onCommit };
  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      const start = drag.current;
      if (!start || event.pointerId !== start.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      const angle = start.table.rotation * Math.PI / 180;
      const delta = ((event.clientX - start.x) * Math.cos(angle) + (event.clientY - start.y) * Math.sin(angle)) / scale;
      if (delta === 0 && start.px === undefined) return;
      start.px = Math.max(12, Math.min(4000, start.width + delta));
      if (previewFrame.current !== undefined) return;
      previewFrame.current = window.requestAnimationFrame(() => {
        previewFrame.current = undefined;
        if (drag.current !== start) return;
        start.latest = { ...start.table, columns: start.table.columns.map(column =>
          column.id === start.columnId ? { ...column, width: { mode: "fixed", px: start.px! } } : column) };
        // Warm the shared cache once; resizers, SVG and hit testing reuse this exact snapshot.
        planTableLayout(start.latest);
        latest.current.onPreview(start.latest);
      });
    };
    const end = (event: globalThis.PointerEvent) => {
      const start = drag.current;
      if (!start || event.pointerId !== start.pointerId) return;
      if (event.type === "pointerup") move(event);
      cancelPreviewFrame();
      drag.current = undefined;
      latest.current.onPreview(undefined);
      const originalWidth = start.table.columns.find(column => column.id === start.columnId)!.width;
      if (event.type === "pointerup" && start.px !== undefined &&
        (originalWidth.mode !== "fixed" || originalWidth.px !== start.px)) {
        const result = setTableColumnWidth(start.table, start.columnId, { mode: "fixed", px: start.px });
        latest.current.onCommit(result.table, "Resize column");
      }
      event.preventDefault(); event.stopPropagation();
    };
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !drag.current) return;
      cancelPreviewFrame();
      drag.current = undefined; latest.current.onPreview(undefined); event.preventDefault(); event.stopPropagation();
    };
    window.addEventListener("pointermove", move, true); window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true); window.addEventListener("keydown", cancel, true);
    return () => {
      cancelPreviewFrame();
      if (drag.current) {
        drag.current = undefined; latest.current.onPreview(undefined);
      }
      window.removeEventListener("pointermove", move, true); window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true); window.removeEventListener("keydown", cancel, true);
    };
  }, [scale]);
  useEffect(() => {
    // A history/command change during a drag must never be overwritten by its old table snapshot.
    if (drag.current && table !== drag.current.table && table !== drag.current.latest) {
      cancelPreviewFrame();
      drag.current = undefined; onPreview(undefined);
    }
  }, [table, onPreview]);
  const layout = planTableLayout(table);
  return <div style={{ position: "absolute", left: table.x * scale, top: table.y * scale,
    width: table.width * scale, height: table.height * scale, transform: `rotate(${table.rotation}deg)`,
    transformOrigin: "center", pointerEvents: "none", zIndex: 3 }}>
    {layout.columns.map((column, index) => <div key={table.columns[index].id}
      data-table-column-resizer={table.columns[index].id} aria-label={`Resize column ${index + 1}`}
      style={{ position: "absolute", left: (column.x + column.width - table.x) * scale - 3,
        top: (layout.bodyBox.y - table.y) * scale, width: 6, height: layout.bodyBox.height * scale,
        cursor: "col-resize", pointerEvents: "auto", touchAction: "none" }}
      onPointerDown={event => {
        if (event.button !== 0 || event.isPrimary === false) return;
        event.preventDefault(); event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
          width: column.width, columnId: table.columns[index].id, table };
      }}
      onDoubleClick={event => {
        event.preventDefault(); event.stopPropagation();
        const result = setTableColumnWidth(table, table.columns[index].id, { mode: "auto" });
        if (table.columns[index].width.mode !== "auto") onCommit(result.table, "Auto-fit column");
      }} />)}
  </div>;
}
