// @vitest-environment jsdom

// The Table section of the floating inspector: PaletteWindow receives the table snapshot over the
// toolset broadcast bridge, renders it only while a table is selected, and routes every control back
// to the main window as a registered command id over the palette-command bridge.

import { readFileSync } from "node:fs";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DefaultNativeTextStyle, deserializeDocument } from "@chemdraft/chem-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PaletteWindow } from "./PaletteWindow";
import { allShellCommands } from "./commands";
import { createPhase4Document } from "./documentWorkflow";
import { createTableCommands, tableInspectorSnapshot } from "./tableCommands";
import type { ToolbarSelectionModel } from "./toolbars/toolbarSelectionKind";
import {
  broadcastToolsetCommandSpecs,
  broadcastToolsetTextStyle,
  createToolsetTextStylePayload
} from "./window-manager";

// A plain palette click is routed to the main window through the native `route_toolset_command`
// invoke (not a DOM event), so capture what the window hands to it.
const routed = vi.hoisted(() => [] as string[]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, payload?: { commandId?: string }) => {
    if (command === "route_toolset_command" && payload?.commandId) routed.push(payload.commandId);
  }
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function selectedTableDocument() {
  const document = deserializeDocument(readFileSync("packages/fixtures/tables/sharpless-reagent-table.json", "utf8"));
  return { ...document, selection: { pageId: document.pages[0].id, objectIds: [document.pages[0].objects[0].id] } };
}

function tableSnapshot() {
  return tableInspectorSnapshot(selectedTableDocument())!;
}

describe("PaletteWindow table inspector", () => {
  let container: HTMLDivElement;
  let root: Root;
  let styles: HTMLStyleElement;

  beforeAll(() => {
    styles = document.createElement("style");
    styles.textContent = readFileSync("apps/desktop/src/App.css", "utf8");
    document.head.append(styles);
  });

  afterAll(() => styles.remove());

  beforeEach(() => {
    routed.length = 0;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  async function mount(toolsetId: string) {
    await act(async () => {
      root.render(createElement(PaletteWindow, { toolsetId }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function broadcast(currentTable?: ReturnType<typeof tableSnapshot>, currentSelection?: ToolbarSelectionModel) {
    await act(async () => {
      await broadcastToolsetTextStyle(
        createToolsetTextStylePayload(DefaultNativeTextStyle, "normal", undefined, "fill", undefined, currentSelection,
          undefined, false, false, currentTable)
      );
    });
  }

  // The main window publishes live command availability; before it does, every table command reads as
  // "Select a table first". Publish the specs a selected table produces.
  async function publishTableCommandSpecs() {
    const live = new Map(createTableCommands(selectedTableDocument()).map((command) => [command.id, command] as const));
    await act(async () => {
      await broadcastToolsetCommandSpecs(
        allShellCommands(createPhase4Document()).map((command) => live.get(command.id) ?? command)
      );
    });
  }

  const click = async (selector: string) => {
    const element = container.querySelector<HTMLButtonElement>(selector);
    if (!element) throw new Error(`Expected ${selector} to render.`);
    await act(async () => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  it("routes header counts and footnote removal and disables unavailable choices with reasons", async () => {
    await mount("core.drawnStructureSettings"); await publishTableCommandSpecs();
    await broadcast({ ...tableSnapshot(), headerRowCount: 1, rowCount: 2, footnoteCount: 1 });
    const header = container.querySelector('[data-command-id="table.headerRows.1"]')!;
    expect(header.getAttribute("aria-pressed")).toBe("true");
    const unavailable = container.querySelector<HTMLButtonElement>('[data-command-id="table.headerRows.3"]')!;
    expect(unavailable.disabled).toBe(true);
    expect(unavailable.title).toBe("Not enough rows in this table");
    await click('[data-command-id="table.headerRows.3"]');
    await click('[data-command-id="table.headerRows.2"]');
    await click('[data-command-id="table.footnote.remove"]');
    expect(routed).toEqual(["table.headerRows.2", "table.footnote.remove"]);
    await broadcast({ ...tableSnapshot(), footnoteCount: 0 });
    const remove = container.querySelector<HTMLButtonElement>('[data-command-id="table.footnote.remove"]')!;
    expect(remove.disabled).toBe(true); expect(remove.title).toBe("Table has no footnotes");
    await click('[data-command-id="table.footnote.remove"]');
    expect(routed).toEqual(["table.headerRows.2", "table.footnote.remove"]);
  });

  it("renders the Table section only while a table is selected", async () => {
    await mount("core.drawnStructureSettings");
    await broadcast(undefined);
    expect(container.querySelector("[data-table-inspector]")).toBeNull();

    await broadcast(tableSnapshot());
    const sections = [...container.querySelectorAll("[data-table-inspector-section]")]
      .map((section) => section.getAttribute("data-table-inspector-section"));
    expect(sections).toEqual(["style", "rules", "header", "font", "column", "caption", "footnotes", "cell"]);

    await broadcast(undefined);
    expect(container.querySelector("[data-table-inspector]")).toBeNull();
  });

  it("does not render the Table section in other palette windows", async () => {
    await mount("core.main");
    await broadcast(tableSnapshot());
    expect(container.querySelector("[data-table-inspector]")).toBeNull();
  });

  it("hides molecule-only settings for a table-only selection and restores them afterwards", async () => {
    await mount("core.drawnStructureSettings");
    expect(container.querySelector('[data-toolbar-style-controls="molecule-inspector"]')).not.toBeNull();
    await broadcast(tableSnapshot(), {
      kind: "mixed", objectTypes: ["table"], moleculeContext: "none", arrowToolIds: [],
      textEditing: false, selectedCount: 1
    });
    expect(container.querySelector("[data-table-inspector]")).not.toBeNull();
    expect(container.querySelector('[data-toolbar-style-controls="molecule-inspector"]')).toBeNull();
    expect(container.querySelector("[data-molecule-inspector-section]")).toBeNull();
    expect(container.querySelector(".palette-window-content")?.firstElementChild?.hasAttribute("data-table-inspector")).toBe(true);

    // A mixed selection can still inspect molecules; do not hide their controls merely because a
    // table snapshot exists. Both inspectors share the same capped scrolling body.
    await broadcast(tableSnapshot(), {
      kind: "mixed", objectTypes: ["molecule", "table"], moleculeContext: "molecule", arrowToolIds: [],
      textEditing: false, selectedCount: 2
    });
    expect(container.querySelector('[data-toolbar-style-controls="molecule-inspector"]')).not.toBeNull();
    expect(container.querySelector("[data-table-inspector]")).not.toBeNull();
    await broadcast(undefined);
    expect(container.querySelector('[data-toolbar-style-controls="molecule-inspector"]')).not.toBeNull();
  });

  it.each(["core.drawnStructureSettings", "core.molecularInspector", "core.ringInspector"])(
    "caps and scrolls the shared body in %s independently of its viewport height", async (toolsetId) => {
      const availableHeight = vi.spyOn(window.screen, "availHeight", "get").mockReturnValue(600);
      await mount(toolsetId);
      await broadcast(tableSnapshot());
      const body = container.querySelector<HTMLElement>(".palette-window-content")!;
      expect(body.style.maxHeight).toBe("578px");
      expect(getComputedStyle(body).overflowY).toBe("auto");
      expect(container.querySelector(".palette-title")?.parentElement).toBe(body.parentElement);
      expect(body.contains(container.querySelector(".palette-title"))).toBe(false);

      // Moving to a smaller work area must update the cap; resizing the webview itself must not.
      availableHeight.mockReturnValue(400);
      await act(async () => {
        window.dispatchEvent(new Event("resize"));
        await new Promise(resolve => setTimeout(resolve, 30));
      });
      expect(body.style.maxHeight).toBe("378px");
      await act(async () => {
        window.dispatchEvent(new Event("resize"));
        await new Promise(resolve => setTimeout(resolve, 30));
      });
      expect(body.style.maxHeight).toBe("378px");
    }
  );

  it.each(["three-line", "grid"] as const)("uses shared inspector controls without wrapping labels for %s", async (preset) => {
    await mount("core.drawnStructureSettings");
    await publishTableCommandSpecs();
    await broadcast({ ...tableSnapshot(), preset, headerBold: true, hasCaption: true });
    const inspector = container.querySelector<HTMLElement>("[data-table-inspector]")!;
    expect(inspector.classList.contains("molecule-inspector-controls")).toBe(true);
    expect(getComputedStyle(inspector).width).toBe("520px");
    expect(inspector.querySelector('input[type="checkbox"]')).toBeNull();

    for (const button of inspector.querySelectorAll<HTMLButtonElement>("button")) {
      expect(button.classList.contains("toolbar-text-button")).toBe(true);
      expect(button.closest(".molecule-inspector-effect-row, .molecule-inspector-template-actions")).not.toBeNull();
      expect(getComputedStyle(button).whiteSpace).toBe("nowrap");
      expect(button.dataset.commandId).toBeTruthy();
      expect(button.dataset.paletteControl).toBe("true");
      if (button.closest(".molecule-inspector-template-actions")) {
        expect(button.classList.contains("molecule-inspector-template-button")).toBe(true);
      }
    }
    for (const field of inspector.querySelectorAll<HTMLElement>("[data-table-control]")) {
      if (field.tagName === "BUTTON") continue;
      expect(field.classList.contains("molecule-inspector-field")).toBe(true);
      expect(getComputedStyle(field.firstElementChild!).whiteSpace).toBe("nowrap");
    }
    for (const id of ["headerBold", "caption"]) {
      const toggle = inspector.querySelector(`[data-table-control="${id}"]`)!;
      expect(toggle.closest(".molecule-inspector-effect-row")).not.toBeNull();
      expect(toggle.getAttribute("aria-pressed")).toBe("true");
      expect(toggle.classList.contains("active")).toBe(true);
    }
    for (const section of inspector.querySelectorAll("[data-table-inspector-section]")) {
      expect(section.classList.contains("molecule-inspector-section")).toBe(true);
      expect(section.firstElementChild?.classList.contains("molecule-inspector-target-label")).toBe(true);
    }
  });

  it("leaves scrollbar presses to the webview while keeping the title draggable", async () => {
    await mount("core.drawnStructureSettings");
    await broadcast(tableSnapshot());
    const body = container.querySelector(".palette-window-content")!;
    for (const type of ["pointerdown", "mousedown"]) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
      await act(async () => { body.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(false);
    }
    const titlePress = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    await act(async () => {
      container.querySelector(".palette-title")!.dispatchEvent(titlePress);
    });
    expect(titlePress.defaultPrevented).toBe(true);
  });

  it("reflects the snapshot: pressed style, header bold, caption, active alignment", async () => {
    await mount("core.drawnStructureSettings");
    const snapshot = tableSnapshot();
    await broadcast({
      ...snapshot,
      preset: "grid",
      headerBold: true,
      hasCaption: true,
      activeColumn: { id: "c", align: "decimal", formula: "auto" }
    });
    const pressed = (commandId: string) =>
      container.querySelector(`[data-command-id="${commandId}"]`)?.getAttribute("aria-pressed");
    expect(pressed("table.style.grid")).toBe("true");
    expect(pressed("table.style.threeLine")).toBe("false");
    expect(pressed("table.header.bold.toggle")).toBe("true");
    expect(pressed("table.caption.toggle")).toBe("true");
    expect(pressed("table.column.align.decimal")).toBe("true");
    expect(pressed("table.column.align.left")).toBe("false");
    expect(container.querySelector('[data-table-control="gridRule"]')?.textContent).toContain("pt");
  });

  it("sends the registered command id when a control is clicked", async () => {
    await mount("core.drawnStructureSettings");
    await publishTableCommandSpecs();
    await broadcast(tableSnapshot());
    const ids = [
      "table.style.grid",
      "table.header.bold.toggle",
      "table.column.align.right",
      "table.column.align.decimal",
      "table.rule.top.0.25",
      "table.rule.header.0.5",
      "table.rule.bottom.2",
      "text.font.times",
      "text.size.18",
      "table.column.formula.off",
      "table.column.formula.auto",
      "table.caption.toggle",
      "table.footnote.add",
      "table.cell.plainText"
    ];
    for (const id of ids) await click(`[data-command-id="${id}"]`);
    expect(routed).toEqual(ids);
  });

  it("carries the command's own disabled reason and sends nothing for a disabled control", async () => {
    await mount("core.drawnStructureSettings");
    await publishTableCommandSpecs();
    await broadcast(tableSnapshot());
    // The fixture's default cell holds no formula, so the registered command is disabled.
    const format = container.querySelector<HTMLButtonElement>('[data-command-id="table.cell.formatFormula"]')!;
    expect(format.disabled).toBe(true);
    expect(format.title).toBe("This cell has no formula to format");
    await click('[data-command-id="table.cell.formatFormula"]');
    expect(routed).toEqual([]);
  });

  it("disables column controls with a reason when there is no active column, and does not send", async () => {
    await mount("core.drawnStructureSettings");
    await broadcast({ ...tableSnapshot(), activeColumn: undefined });
    const left = container.querySelector<HTMLButtonElement>('[data-command-id="table.column.align.left"]')!;
    expect(left.disabled).toBe(true);
    expect(left.title).toBe("Click a cell to choose a column");
    await click('[data-command-id="table.column.align.left"]');
    const formula = container.querySelector<HTMLButtonElement>('[data-command-id="table.column.formula.auto"]')!;
    expect(formula.disabled).toBe(true);
    expect(formula.title).toBe("Click a cell to choose a column");
    await click('[data-command-id="table.column.formula.auto"]');
    expect(routed).toEqual([]);
  });

  it("reflects rule widths, font family and size, and column formula selections", async () => {
    await mount("core.drawnStructureSettings");
    await broadcast({ ...tableSnapshot(), preset: "three-line", topRulePt: 1.5, fontFamily: "Georgia, serif", fontSizePx: 24 });
    const inspector = container.querySelector("[data-table-inspector]")!;
    expect(inspector.querySelector('[data-table-control="topRule"]')?.textContent).toContain("1.5 pt");
    for (const id of ["table.rule.top.1.5", "text.font.georgia", "text.size.18"]) {
      expect(inspector.querySelector(`[data-command-id="${id}"]`)?.getAttribute("aria-pressed")).toBe("true");
    }
    expect(inspector.querySelector('[data-table-control="gridRule"]')).toBeNull();
    await broadcast({ ...tableSnapshot(), preset: "grid", gridRulePt: 0.75 });
    expect(inspector.querySelector('[data-table-control="topRule"]')).toBeNull();
    expect(inspector.querySelector('[data-command-id="table.rule.grid.0.75"]')?.getAttribute("aria-pressed")).toBe("true");
    await publishTableCommandSpecs();
    await click('[data-command-id="table.rule.grid.0.5"]');
    expect(routed).toEqual(["table.rule.grid.0.5"]);
  });

  it("does not send unavailable rule, font or formula commands and shows their reasons", async () => {
    await mount("core.drawnStructureSettings");
    const ids = ["table.rule.top.0.5", "text.font.times", "text.size.12", "table.column.formula.off"];
    await act(async () => {
      await broadcastToolsetCommandSpecs(allShellCommands(selectedTableDocument()).map(command => ids.includes(command.id)
        ? { ...command, enabled: false, disabledReason: "Finish editing first" } : command));
    });
    await broadcast(tableSnapshot());
    for (const id of ids) {
      const button = container.querySelector<HTMLButtonElement>(`[data-table-inspector] [data-command-id="${id}"]`)!;
      expect(button.disabled).toBe(true);
      expect(button.title).toBe("Finish editing first");
      await click(`[data-table-inspector] [data-command-id="${id}"]`);
    }
    expect(routed).toEqual([]);
  });
});
