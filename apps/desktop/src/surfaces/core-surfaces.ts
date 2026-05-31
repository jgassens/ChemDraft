import type { SurfaceDefinition } from "./schema";

export const coreSurfaceDefinitions = [
  {
    id: "surface.menu.file.new",
    kind: "menu-item",
    source: "core",
    slot: "menu.file",
    commandId: "document.new",
    label: "New",
    order: 10,
    defaultVisibility: "visible"
  },
  {
    id: "surface.menu.file.open",
    kind: "menu-item",
    source: "core",
    slot: "menu.file",
    commandId: "document.open",
    label: "Open",
    order: 20,
    defaultVisibility: "visible"
  },
  {
    id: "surface.menu.view.rulers",
    kind: "menu-item",
    source: "core",
    slot: "menu.view",
    commandId: "view.toggleRulers",
    label: "Show Rulers",
    order: 10,
    defaultVisibility: "visible"
  },
  {
    id: "surface.status.zoom",
    kind: "status-item",
    source: "core",
    slot: "status.right",
    label: "Zoom",
    order: 100,
    defaultVisibility: "visible"
  },
  {
    id: "surface.canvas.addPageAfter",
    kind: "canvas-control",
    source: "core",
    slot: "canvas.page.bottomRight",
    commandId: "document.addPageAfter",
    label: "Add Page",
    icon: "plus-circle",
    order: 100,
    defaultVisibility: "disabled",
    disabledReason: "Add-page command is planned but not implemented yet"
  }
] satisfies readonly SurfaceDefinition[];
