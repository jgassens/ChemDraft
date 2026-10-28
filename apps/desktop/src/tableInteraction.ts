import { TABLE_LIMITS, type TableObject } from "@chemdraft/chem-core";
import { planTableLayout } from "@chemdraft/layout-engine";
import type { ActiveTableCell } from "./tableCommands";

export type TableEditingAction =
  | { kind: "caret" }
  | { kind: "lineBreak" }
  | { kind: "cancel" }
  | { kind: "commit"; next?: ActiveTableCell; insertRow?: boolean };

/** The textarea does not wrap, matching the table layout. Offsets therefore identify visual lines. */
export function tableEditingKeyAction(table: TableObject, cell: ActiveTableCell, event: {
  key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean;
  isComposing?: boolean;
}, text: string, start: number, end = start): TableEditingAction {
  if (event.isComposing) return { kind: "caret" };
  if (event.key === "Escape") return { kind: "cancel" };
  if (event.ctrlKey || event.metaKey || event.altKey) return { kind: "caret" };
  const row = table.rows.findIndex(item => item.id === cell.rowId);
  const column = table.columns.findIndex(item => item.id === cell.columnId);
  const move = (r: number, c: number): TableEditingAction => ({ kind: "commit",
    ...(table.rows[r] && table.columns[c] ? {
      next: { tableId: table.id, rowId: table.rows[r].id, columnId: table.columns[c].id }
    } : {}) });
  if (event.key === "Tab") {
    const index = row * table.columns.length + column + (event.shiftKey ? -1 : 1);
    if (index === table.rows.length * table.columns.length) {
      return { kind: "commit", insertRow: table.rows.length < TABLE_LIMITS.maxRows };
    }
    return move(Math.floor(index / table.columns.length), index % table.columns.length);
  }
  if (event.key === "Enter") return event.shiftKey ? { kind: "lineBreak" } : move(row + 1, column);
  if (start !== end || event.shiftKey) return { kind: "caret" };
  if (event.key === "ArrowLeft" && start === 0) return move(row, column - 1);
  if (event.key === "ArrowRight" && end === text.length) return move(row, column + 1);
  if (event.key === "ArrowUp" && !text.slice(0, start).includes("\n")) return move(row - 1, column);
  if (event.key === "ArrowDown" && !text.slice(end).includes("\n")) return move(row + 1, column);
  return { kind: "caret" };
}

/** Invert the SVG table rotation, whose pivot is the stored frame's centre. */
export function unrotateTablePoint(table: TableObject, point: { x: number; y: number }) {
  const angle = -table.rotation * Math.PI / 180;
  const cx = table.x + table.width / 2, cy = table.y + table.height / 2;
  const x = point.x - cx, y = point.y - cy;
  return { x: cx + x * Math.cos(angle) - y * Math.sin(angle),
    y: cy + x * Math.sin(angle) + y * Math.cos(angle) };
}

export function tableCellAtPoint(table: TableObject, pagePoint: { x: number; y: number }): ActiveTableCell | undefined {
  const point = unrotateTablePoint(table, pagePoint);
  const hit = planTableLayout(table).cells.find(({ box }) => point.x >= box.x && point.x <= box.x + box.width &&
    point.y >= box.y && point.y <= box.y + box.height);
  return hit ? { tableId: table.id, rowId: table.rows[hit.rowIndex].id,
    columnId: table.columns[hit.columnIndex].id } : undefined;
}
