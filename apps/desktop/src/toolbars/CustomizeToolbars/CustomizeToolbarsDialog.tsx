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
  hiddenToolsetItemIds,
  mergeToolsetItemAdditions,
  toolsetItemCustomizationId,
  type ToolsetGroupDefinition,
  type ToolsetItemDefinition,
  type ToolsetLayoutState
} from "@chemdraft/toolset-registry";
import type { DesktopToolsetDefinition } from "../../toolsets";
import { SHELL_COMMAND_IDS } from "../../shellCommandIds";
import { WIDGET_CONTROL_ID_PREFIX } from "../toolbarWidgets";
import { nativePrompt } from "../../nativePrompt";
import {
  USER_TOOLSET_ID_PREFIX,
  addToolsetItemAddition,
  cloneToolset,
  createCommandToolbarItem,
  createUserToolset,
  deleteUserToolset,
  renameToolset,
  removeToolsetItem,
  removedToolsetItemIds,
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

function toolbarItemIds(groups: readonly ToolsetGroupDefinition<string, string>[]): Set<string> {
  return new Set(groups.flatMap((group) => group.items.map(itemCustomizationId)));
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

/** Ask before Reset to Defaults, with a native message box on both desktop platforms (the browser
 *  build falls back to nativePrompt's DOM prompt). Cancel is the safe choice. */
export async function confirmResetToolbarToDefaults(toolsetTitle: string): Promise<boolean> {
  const choice = await nativePrompt({
    title: `Reset “${toolsetTitle}” to its defaults?`,
    message: "This restores the toolbar’s default buttons, order, name and visibility. Buttons you removed come back and "
      + "buttons you added are taken off. No commands are changed; they stay available from menus, shortcuts and "
      + "Customize Toolbars.",
    kind: "warning",
    owner: "document",
    choices: [
      { id: "reset", label: "Reset to Defaults", destructive: true },
      { id: "cancel", label: "Cancel", cancel: true }
    ]
  });
  return choice === "reset";
}

export interface CustomizeToolbarsDialogProps {
  /** Core ∪ plugin toolsets BEFORE layout state (the draft is re-applied on top for the preview). */
  baseToolsets: readonly DesktopToolsetDefinition[];
  /** The layout state to edit (the dialog keeps its own draft and only reports it back on Apply). */
  layoutState: LayoutState;
  /** Commands available to add from the command registry. */
  availableCommands?: readonly CommandOption[];
  /** Hide commands from the dialog only; their saved layout and ordering remain intact. */
  isCommandHidden?: (commandId: string) => boolean;
  onApply: (next: LayoutState) => void;
  /** Applied immediately on each edit (visibility toggles, hides, reorders) for live preview —
   *  palettes appear/disappear as you click instead of only on Apply. */
  onLiveApply?: (next: LayoutState) => void;
  onClose: () => void;
  /** Confirms Reset to Defaults; defaults to {@link confirmResetToolbarToDefaults}. */
  confirmReset?: (toolsetTitle: string) => Promise<boolean>;
}

/** Apply the draft to the base toolsets so the list reflects order, visibility, and renames live.
 *  `error` is true when the draft can't be applied (e.g. a corrupt loaded state) — the preview falls
 *  back to the base set, and the dialog blocks Apply so a broken draft is never committed. */
function useEffectiveToolsets(
  baseToolsets: readonly DesktopToolsetDefinition[],
  draft: LayoutState,
  availableCommands: readonly CommandOption[]
) {
  return useMemo(() => {
    try {
      // Let the generics infer from baseToolsets (DesktopToolsetDefinition) so the result stays
      // desktop-typed for SortableToolsetRow; a literal <string, string> is unsound here (string is
      // not assignable to IconName) and only compiled by TS eliding a deep comparison.
      return {
        toolsets: applyToolsetLayoutState([...baseToolsets], draft, {
          additionalCommandIds: new Set([...SHELL_COMMAND_IDS, ...availableCommands.map(command => command.id)]),
          onUnknownCommand: "prune"
        }),
        error: false
      };
    } catch {
      return { toolsets: [...baseToolsets], error: true };
    }
  }, [baseToolsets, draft, availableCommands]);
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
      {isUser ? null : (
        // A user toolbar has no defaults to return to (its items are its own); Delete removes it.
        <button
          type="button"
          className="customize-toolset-action customize-toolset-reset"
          onClick={onReset}
          title={`Reset ${toolset.title} to Defaults`}
        >
          Reset to Defaults
        </button>
      )}
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
  isCommandHidden,
  onApply,
  onLiveApply,
  onClose,
  confirmReset = confirmResetToolbarToDefaults
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
  const { toolsets: effective, error: draftError } = useEffectiveToolsets(baseToolsets, draft, availableCommands);
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
  const selectedTitle =
    effective.find((toolset) => toolset.id === selectedToolsetId)?.title ?? selectedBase?.title ?? "";

  const selectedOverride = draft.toolsetOverrides.find((entry) => entry.toolsetId === selectedToolsetId);
  const hiddenItemIds = useMemo(() => hiddenToolsetItemIds(selectedOverride), [selectedOverride]);
  // Removed built-in items leave the list (like a removed addition) and are offered under "Add
  // command…"; their commands stay registered. Merely unchecked items stay listed.
  const removedItemIds = useMemo(
    () => (selectedToolsetId ? removedToolsetItemIds(draft, selectedToolsetId) : new Set<string>()),
    [draft, selectedToolsetId]
  );
  const groupsWithAdditions = useMemo(
    () => mergeToolsetItemAdditions<string, string>(selectedBase?.groups ?? [], selectedOverride?.itemAdditions),
    [selectedBase, selectedOverride?.itemAdditions]
  );

  const detailGroups: CustomizeGroupModel[] = useMemo(() => {
    return groupsWithAdditions.map((group) => {
      const groupId = group.id ?? "";
      const ordered = orderItemsByIds(group.items, groupId ? selectedOverride?.itemOrder?.[groupId] : undefined);
      return {
        id: groupId,
        title: group.title,
        items: ordered
          .map((item) => {
            const id = itemCustomizationId(item);
            return {
              id,
              label: item.label ?? id,
              hidden: hiddenItemIds.has(id),
              isWidget: isWidgetItem(item),
              // Every item can be removed: an addition or a user toolbar's item is deleted, a built-in
              // item is hidden and marked removed (see removeToolsetItem).
              canRemove: true
            };
          })
          .filter((item) => item.id.length > 0 && !removedItemIds.has(item.id))
      };
    });
  }, [groupsWithAdditions, hiddenItemIds, removedItemIds, selectedOverride]);

  const displayedGroups = useMemo(() => isCommandHidden
    ? detailGroups.map((group) => ({ ...group, items: group.items.filter((item) => !isCommandHidden(item.id)) }))
    : detailGroups, [detailGroups, isCommandHidden]);

  const availableForToolset: CommandOption[] = useMemo(() => {
    const present = toolbarItemIds(groupsWithAdditions);
    hiddenItemIds.forEach((id) => present.delete(id));
    const offered = availableCommands.filter((command) => !isCommandHidden?.(command.id) && !present.has(command.id));
    // A removed built-in item must always be addable back, even when it is not a gallery command
    // (a widget, or a command the gallery omits); re-adding un-hides it in its manifest slot.
    const offeredIds = new Set(offered.map((command) => command.id));
    const removed = groupsWithAdditions.flatMap((group) => group.items).flatMap((item) => {
      const id = itemCustomizationId(item);
      return removedItemIds.has(id) && !offeredIds.has(id) && !isCommandHidden?.(id)
        ? [{ id, title: item.label ?? id }]
        : [];
    });
    return [...removed, ...offered];
  }, [availableCommands, groupsWithAdditions, hiddenItemIds, isCommandHidden, removedItemIds]);

  const addCommand = (command: CommandOption) => {
    if (!selectedBase) {
      return;
    }
    const toolsetId = selectedBase.id;
    setDraft((current) => {
      const userToolset = current.userToolsets.find((entry) => entry.id === toolsetId);
      const toolset = userToolset ?? baseById.get(toolsetId);
      if (!toolset) {
        return current;
      }
      const override = current.toolsetOverrides.find((entry) => entry.toolsetId === toolsetId);
      const groups = mergeToolsetItemAdditions<string, string>(toolset.groups, override?.itemAdditions);
      const presentItemIds = toolbarItemIds(groups);
      const wasHidden = hiddenToolsetItemIds(override).has(command.id);
      if (presentItemIds.has(command.id)) {
        return wasHidden ? setItemHidden(current, toolsetId, command.id, false) : current;
      }
      const item = createCommandToolbarItem(command);
      const targetGroup = toolset.groups.find((group) => group.id) ?? toolset.groups[0];
      let next = current;
      if (userToolset && targetGroup) {
        const userGroups = userToolset.groups.map((group) =>
          group === targetGroup ? { ...group, items: [...group.items, item] } : group
        );
        next = setUserToolsetGroups(current, toolsetId, userGroups);
      } else if (targetGroup?.id) {
        next = addToolsetItemAddition(current, toolsetId, { groupId: targetGroup.id, item }, { presentItemIds });
      }
      return next !== current && wasHidden
        ? setItemHidden(next, toolsetId, command.id, false)
        : next;
    });
  };

  const removeItem = (groupId: string, itemId: string) => {
    if (!selectedToolsetId) {
      return;
    }
    setDraft((current) => {
      const toolset = current.userToolsets.find((entry) => entry.id === selectedToolsetId);
      if (!toolset?.groups.some((group) =>
        (group.id ?? "") === groupId && group.items.some((item) => itemCustomizationId(item) === itemId)
      )) {
        return removeToolsetItem(current, selectedToolsetId, itemId);
      }
      const groups: ToolsetGroupDefinition<string, string>[] = toolset.groups.map((group) =>
        (group.id ?? "") === groupId
          ? { ...group, items: group.items.filter((item) => itemCustomizationId(item) !== itemId) }
          : group
      );
      return setUserToolsetGroups(current, toolset.id, groups);
    });
  };

  // Reset to Defaults asks first (a native message box). The answer arrives asynchronously, so it is
  // ignored once the dialog has closed rather than writing into an unmounted draft.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const resetToDefaults = async (toolsetId: string, toolsetTitle: string) => {
    let confirmed = false;
    try {
      confirmed = await confirmReset(toolsetTitle);
    } catch (error) {
      console.error(`Reset to Defaults confirmation failed for toolbar "${toolsetId}"`, error);
    }
    if (confirmed && mountedRef.current) {
      setDraft((current) => resetToolsetLayout(current, toolsetId));
    }
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
      if (event.key !== "Escape") {
        return;
      }
      // Escape inside a text field means "abandon this edit", not "throw away the whole session".
      // Without this check, pressing it while renaming a toolbar rolled every live-applied edit —
      // reorderings, hides, deletions — back to the state the dialog opened with.
      const target = event.target;
      if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        target.blur();
        return;
      }
      event.preventDefault();
      cancelAndClose();
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
                      onReset={() => void resetToDefaults(toolset.id, toolset.title)}
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
                key={selectedBase.id}
                toolsetTitle={selectedTitle}
                groups={displayedGroups}
                availableCommands={availableForToolset}
                onReorderItems={(groupId, orderedItemIds) => {
                  if (selectedToolsetId) {
                    // Reorder only displayed slots, retaining feature-hidden commands in place.
                    const group = detailGroups.find((entry) => entry.id === groupId);
                    let index = 0;
                    const order = isCommandHidden && group
                      ? group.items.map((item) => isCommandHidden(item.id) ? item.id : orderedItemIds[index++]!)
                      : orderedItemIds;
                    setDraft((current) => reorderItems(current, selectedToolsetId, groupId, order));
                  }
                }}
                onToggleItemHidden={(itemId, hidden) => {
                  if (selectedToolsetId) {
                    setDraft((current) => setItemHidden(current, selectedToolsetId, itemId, hidden));
                  }
                }}
                onRemoveItem={removeItem}
                onAddCommand={addCommand}
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
