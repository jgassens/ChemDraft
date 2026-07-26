import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  applyToolsetLayoutState,
  mergeToolsetItemAdditions,
  toolsetItemCustomizationId,
  type ToolsetGroupDefinition,
  type ToolsetItemDefinition,
  type ToolsetLayoutState
} from "@chemdraft/toolset-registry";
import type { DesktopToolsetDefinition } from "../../toolsets";
import { SHELL_COMMAND_IDS } from "../../shellCommandIds";
import { WIDGET_CONTROL_ID_PREFIX } from "../toolbarWidgets";
import {
  USER_TOOLSET_ID_PREFIX,
  cloneToolset,
  createUserToolset,
  deleteUserToolset,
  renameToolset,
  reorderItems,
  reorderToolsets,
  resetToolsetLayout,
  setItemHidden,
  setToolsetVisible,
  setUserToolsetGroups
} from "./layoutStateEdits";
import { CustomizeToolsetDetail, type CommandOption, type CustomizeGroupModel } from "./CustomizeToolsetDetail";
import "./CustomizeToolbars.css";

// Delegate to the registry's customization-id logic so the dialog and applyUserToolsetOverride key
// items IDENTICALLY (a divergence would silently drop the user's reorder/hide). Empty string = an
// item with no customization key (e.g. a separator), which the detail model filters out.
function itemCustomizationId(item: ToolsetItemDefinition<string, string>): string {
  return toolsetItemCustomizationId(item) ?? "";
}

function isWidgetItem(item: ToolsetItemDefinition<string, string>): boolean {
  return item.primary?.type === "control" && item.primary.controlId.startsWith(WIDGET_CONTROL_ID_PREFIX);
}

/** Order items by a preferred id list (matching applyUserToolsetOverride), unlisted items kept last. */
function orderItemsByIds(
  items: readonly ToolsetItemDefinition<string, string>[],
  order: readonly string[] | undefined
): ToolsetItemDefinition<string, string>[] {
  if (!order || order.length === 0) {
    return [...items];
  }
  const byId = new Map(items.map((item) => [itemCustomizationId(item), item]));
  const ordered: ToolsetItemDefinition<string, string>[] = [];
  const used = new Set<string>();
  for (const id of order) {
    const item = byId.get(id);
    if (item && !used.has(id)) {
      ordered.push(item);
      used.add(id);
    }
  }
  for (const item of items) {
    if (!used.has(itemCustomizationId(item))) {
      ordered.push(item);
    }
  }
  return ordered;
}

type LayoutState = ToolsetLayoutState<string, string>;

export interface CustomizeToolbarsDialogProps {
  /** Core ∪ plugin toolsets BEFORE layout state (the draft is re-applied on top for the preview). */
  baseToolsets: readonly DesktopToolsetDefinition[];
  /** The layout state to edit (the dialog keeps its own draft and only reports it back on Apply). */
  layoutState: LayoutState;
  /** All commands available to add to a user toolset (from the command registry). */
  availableCommands?: readonly CommandOption[];
  onApply: (next: LayoutState) => void;
  /** Applied immediately on each edit (visibility toggles, hides, reorders) for live preview —
   *  palettes appear/disappear as you click instead of only on Apply. */
  onLiveApply?: (next: LayoutState) => void;
  onClose: () => void;
}

/** Apply the draft to the base toolsets so the list reflects order, visibility, and renames live.
 *  `error` is true when the draft can't be applied (e.g. a corrupt loaded state) — the preview falls
 *  back to the base set, and the dialog blocks Apply so a broken draft is never committed. */
function useEffectiveToolsets(baseToolsets: readonly DesktopToolsetDefinition[], draft: LayoutState) {
  return useMemo(() => {
    try {
      // Let the generics infer from baseToolsets (DesktopToolsetDefinition) so the result stays
      // desktop-typed for SortableToolsetRow; a literal <string, string> is unsound here (string is
      // not assignable to IconName) and only compiled by TS eliding a deep comparison.
      return {
        toolsets: applyToolsetLayoutState([...baseToolsets], draft, {
          additionalCommandIds: SHELL_COMMAND_IDS,
          onUnknownCommand: "prune"
        }),
        error: false
      };
    } catch {
      return { toolsets: [...baseToolsets], error: true };
    }
  }, [baseToolsets, draft]);
}

function SortableToolsetRow({
  toolset,
  selected,
  onSelect,
  onToggleVisible,
  onRename,
  onReset,
  onClone,
  onDelete
}: {
  toolset: DesktopToolsetDefinition;
  selected: boolean;
  onSelect: () => void;
  onToggleVisible: (visible: boolean) => void;
  onRename: (title: string) => void;
  onReset: () => void;
  onClone: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: toolset.id });
  const isUser = toolset.id.startsWith(USER_TOOLSET_ID_PREFIX);
  const commitRename = (event: { currentTarget: HTMLInputElement }) => {
    // Only write when the title actually changed. Committing on every blur — including a mere
    // focus-through with no edit — would pin a title override onto the toolset, freezing it against
    // future manifest renames and writing junk to disk (edits apply live). Trimmed compare matches
    // renameToolset, which clears the override when the field is emptied.
    if (event.currentTarget.value.trim() === toolset.title) {
      return;
    }
    onRename(event.currentTarget.value);
  };

  return (
    <li
      ref={setNodeRef}
      className={["customize-toolset-row", selected ? "is-selected" : ""].filter(Boolean).join(" ")}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 }}
      data-toolset-id={toolset.id}
      data-selected={selected ? "true" : undefined}
    >
      <button
        type="button"
        className="customize-drag-handle"
        aria-label={`Reorder ${toolset.title}`}
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>
      <input
        type="checkbox"
        className="customize-toolset-visible"
        aria-label={`Show ${toolset.title}`}
        checked={toolset.defaultVisible}
        onChange={(event) => onToggleVisible(event.currentTarget.checked)}
      />
      <input
        // Uncontrolled for smooth typing, but keyed on the effective title so an external change —
        // a committed rename, or Reset reverting to the manifest title — remounts the field with the
        // new value instead of stranding the stale text the user last typed.
        key={toolset.title}
        type="text"
        className="customize-toolset-title"
        aria-label={`Rename ${toolset.title}`}
        defaultValue={toolset.title}
        onClick={onSelect}
        onFocus={onSelect}
        onBlur={commitRename}
        onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
          if (event.key === "Enter") {
            commitRename(event);
            event.currentTarget.blur();
          }
        }}
      />
      <span className="customize-toolset-source" data-source={toolset.source}>
        {toolset.source === "user" ? "custom" : toolset.source}
      </span>
      <button type="button" className="customize-toolset-action" onClick={onClone} title={`Duplicate ${toolset.title}`}>
        Duplicate
      </button>
      <button type="button" className="customize-toolset-action" onClick={onReset} title={`Reset ${toolset.title}`}>
        Reset
      </button>
      {isUser ? (
        <button
          type="button"
          className="customize-toolset-action customize-toolset-delete"
          onClick={onDelete}
          title={`Delete ${toolset.title}`}
        >
          Delete
        </button>
      ) : null}
    </li>
  );
}

export function CustomizeToolbarsDialog({
  baseToolsets,
  layoutState,
  availableCommands = [],
  onApply,
  onLiveApply,
  onClose
}: CustomizeToolbarsDialogProps) {
  const [draft, setDraft] = useState<LayoutState>(layoutState);
  // Live preview: every edit applies immediately (palettes appear/disappear as you click), instead of
  // only on Apply. Keep the open-time state so Cancel can revert. Refs avoid re-firing on prop identity.
  const initialLayoutRef = useRef(layoutState);
  const onLiveApplyRef = useRef(onLiveApply);
  onLiveApplyRef.current = onLiveApply;
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    onLiveApplyRef.current?.(draft);
  }, [draft]);
  const { toolsets: effective, error: draftError } = useEffectiveToolsets(baseToolsets, draft);
  const [selectedToolsetId, setSelectedToolsetId] = useState<string | undefined>(effective[0]?.id);
  const [newToolbarName, setNewToolbarName] = useState("");

  const sensors = useSensors(
    // A small activation distance makes dragging robust: without it dnd-kit starts a drag on the
    // tiniest pointer move, so a plain click's micro-movement can start-then-instantly-cancel a drag
    // (which read as "drag does nothing" in the native WKWebView). 5px cleanly separates click vs drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const baseById = useMemo(() => new Map(baseToolsets.map((toolset) => [toolset.id, toolset])), [baseToolsets]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }
    const ids = effective.map((toolset) => toolset.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) {
      return;
    }
    setDraft((current) => reorderToolsets(current, arrayMove(ids, from, to)));
  };

  const handleClone = (toolsetId: string) => {
    // Clone the EFFECTIVE (post-override) toolset so the copy matches what's on screen — the user's
    // hides/reorders/renames are included; fall back to the base only if it isn't in the list.
    const source = effective.find((toolset) => toolset.id === toolsetId) ?? baseById.get(toolsetId);
    if (!source) {
      return;
    }
    // Compute then set — keeping setState updaters pure (no setSelectedToolsetId inside setDraft).
    const result = cloneToolset(draft, source);
    setDraft(result.state);
    setSelectedToolsetId(result.toolsetId);
  };

  const handleCreate = () => {
    const title = newToolbarName.trim() || "New Toolbar";
    const result = createUserToolset(draft, { title });
    setDraft(result.state);
    setSelectedToolsetId(result.toolsetId);
    setNewToolbarName("");
  };

  // The selected toolset's structural source: a user toolset's own groups, else the base manifest.
  const selectedBase = useMemo(
    () => draft.userToolsets.find((toolset) => toolset.id === selectedToolsetId) ?? baseById.get(selectedToolsetId ?? ""),
    [draft.userToolsets, baseById, selectedToolsetId]
  );
  const selectedIsUser = (selectedToolsetId ?? "").startsWith(USER_TOOLSET_ID_PREFIX);
  const selectedTitle =
    effective.find((toolset) => toolset.id === selectedToolsetId)?.title ?? selectedBase?.title ?? "";

  const detailGroups: CustomizeGroupModel[] = useMemo(() => {
    if (!selectedBase) {
      return [];
    }
    const override = draft.toolsetOverrides.find((entry) => entry.toolsetId === selectedToolsetId);
    const hidden = new Set(override?.hiddenCommandIds ?? []);
    const additions = override?.itemAdditions ?? [];
    const groupsWithAdditions = mergeToolsetItemAdditions<string, string>(selectedBase.groups, additions);
    return groupsWithAdditions.map((group) => {
      const groupId = group.id ?? "";
      const ordered = orderItemsByIds(group.items, groupId ? override?.itemOrder?.[groupId] : undefined);
      return {
        id: groupId,
        title: group.title,
        items: ordered
          .map((item) => {
            const id = itemCustomizationId(item);
            return { id, label: item.label ?? id, hidden: hidden.has(id), isWidget: isWidgetItem(item) };
          })
          .filter((item) => item.id.length > 0)
      };
    });
  }, [selectedBase, draft.toolsetOverrides, selectedToolsetId]);

  const availableForToolset: CommandOption[] = useMemo(() => {
    const present = new Set(detailGroups.flatMap((group) => group.items.map((item) => item.id)));
    return availableCommands.filter((command) => !present.has(command.id));
  }, [availableCommands, detailGroups]);

  const addCommandToUserToolset = (groupId: string, command: CommandOption) => {
    setDraft((current) => {
      const toolset = current.userToolsets.find((entry) => entry.id === selectedToolsetId);
      if (!toolset) {
        return current;
      }
      const newItem: ToolsetItemDefinition<string, string> = {
        id: command.id,
        kind: "button",
        label: command.title,
        primary: { type: "command", commandId: command.id },
        submenu: null
      };
      const groups: ToolsetGroupDefinition<string, string>[] = toolset.groups.map((group) =>
        (group.id ?? "") === groupId ? { ...group, items: [...group.items, newItem] } : group
      );
      return setUserToolsetGroups(current, toolset.id, groups);
    });
  };

  const removeItemFromUserToolset = (groupId: string, itemId: string) => {
    setDraft((current) => {
      const toolset = current.userToolsets.find((entry) => entry.id === selectedToolsetId);
      if (!toolset) {
        return current;
      }
      const groups: ToolsetGroupDefinition<string, string>[] = toolset.groups.map((group) =>
        (group.id ?? "") === groupId
          ? { ...group, items: group.items.filter((item) => itemCustomizationId(item) !== itemId) }
          : group
      );
      return setUserToolsetGroups(current, toolset.id, groups);
    });
  };

  // Every edit applies live (and persists), so dismissing the dialog must ROLL BACK to the state it
  // opened with — otherwise the ×, a backdrop click, and Escape would silently behave like Apply. Only
  // the Apply button commits the draft. This is the single dismiss path for all three affordances.
  const cancelAndClose = () => {
    onLiveApply?.(initialLayoutRef.current);
    onClose();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelAndClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // cancelAndClose closes over stable refs/props (onLiveApply, onClose); rebinding each render is
    // harmless and keeps the latest closure without extra deps churn.
  });

  return (
    <div className="customize-toolbars-backdrop" role="presentation" onClick={cancelAndClose}>
      <div
        className="customize-toolbars-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Customize Toolbars"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="customize-toolbars-header">
          <h2>Customize Toolbars</h2>
          <button type="button" className="customize-toolbars-close" aria-label="Close" onClick={cancelAndClose}>
            ×
          </button>
        </header>

        <div className="customize-toolbars-body">
          <div className="customize-toolset-pane">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={effective.map((toolset) => toolset.id)} strategy={verticalListSortingStrategy}>
                <ul className="customize-toolset-list" aria-label="Toolbars">
                  {effective.map((toolset) => (
                    <SortableToolsetRow
                      key={toolset.id}
                      toolset={toolset}
                      selected={toolset.id === selectedToolsetId}
                      onSelect={() => setSelectedToolsetId(toolset.id)}
                      onToggleVisible={(visible) => setDraft((current) => setToolsetVisible(current, toolset.id, visible))}
                      onRename={(title) => setDraft((current) => renameToolset(current, toolset.id, title))}
                      onReset={() => setDraft((current) => resetToolsetLayout(current, toolset.id))}
                      onClone={() => handleClone(toolset.id)}
                      onDelete={() => {
                        setDraft((current) => deleteUserToolset(current, toolset.id));
                        setSelectedToolsetId((current) => (current === toolset.id ? undefined : current));
                      }}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          </div>
          <div className="customize-detail-pane">
            {selectedBase ? (
              <CustomizeToolsetDetail
                toolsetTitle={selectedTitle}
                isUser={selectedIsUser}
                groups={detailGroups}
                availableCommands={availableForToolset}
                onReorderItems={(groupId, orderedItemIds) => {
                  if (selectedToolsetId) {
                    setDraft((current) => reorderItems(current, selectedToolsetId, groupId, orderedItemIds));
                  }
                }}
                onToggleItemHidden={(itemId, hidden) => {
                  if (selectedToolsetId) {
                    setDraft((current) => setItemHidden(current, selectedToolsetId, itemId, hidden));
                  }
                }}
                onRemoveItem={removeItemFromUserToolset}
                onAddCommand={addCommandToUserToolset}
              />
            ) : (
              <p className="customize-detail-empty">Select a toolbar to edit its contents.</p>
            )}
          </div>
        </div>

        <div className="customize-toolbars-create">
          <input
            type="text"
            aria-label="New toolbar name"
            placeholder="New toolbar name"
            value={newToolbarName}
            onChange={(event) => setNewToolbarName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                handleCreate();
              }
            }}
          />
          <button type="button" onClick={handleCreate}>
            Create Toolbar
          </button>
        </div>

        <footer className="customize-toolbars-footer">
          {draftError ? (
            <span className="customize-toolbars-error" role="alert">
              This customization can’t be applied. Cancel to keep your current toolbars.
            </span>
          ) : null}
          <button type="button" className="customize-toolbars-cancel" onClick={cancelAndClose}>
            Cancel
          </button>
          <button
            type="button"
            className="customize-toolbars-apply"
            disabled={draftError}
            onClick={() => onApply(draft)}
          >
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}
