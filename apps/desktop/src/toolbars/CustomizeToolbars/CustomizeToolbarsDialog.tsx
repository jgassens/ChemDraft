import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
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
import { applyToolsetLayoutState, type ToolsetLayoutState } from "@chemdraft/toolset-registry";
import type { DesktopToolsetDefinition } from "../../toolsets";
import { USER_TOOLSET_ID_PREFIX } from "./layoutStateEdits";
import {
  cloneToolset,
  createUserToolset,
  deleteUserToolset,
  renameToolset,
  reorderToolsets,
  resetToolsetLayout,
  setToolsetVisible
} from "./layoutStateEdits";
import "./CustomizeToolbars.css";

type LayoutState = ToolsetLayoutState<string, string>;

export interface CustomizeToolbarsDialogProps {
  /** Core ∪ plugin toolsets BEFORE layout state (the draft is re-applied on top for the preview). */
  baseToolsets: readonly DesktopToolsetDefinition[];
  /** The layout state to edit (the dialog keeps its own draft and only reports it back on Apply). */
  layoutState: LayoutState;
  onApply: (next: LayoutState) => void;
  onClose: () => void;
}

/** Apply the draft to the base toolsets so the list reflects order, visibility, and renames live. */
function useEffectiveToolsets(baseToolsets: readonly DesktopToolsetDefinition[], draft: LayoutState) {
  return useMemo(() => {
    try {
      return applyToolsetLayoutState<string, string>([...baseToolsets], draft, { onUnknownCommand: "prune" });
    } catch {
      return [...baseToolsets];
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
  const commitRename = (event: { currentTarget: HTMLInputElement }) => onRename(event.currentTarget.value);

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

export function CustomizeToolbarsDialog({ baseToolsets, layoutState, onApply, onClose }: CustomizeToolbarsDialogProps) {
  const [draft, setDraft] = useState<LayoutState>(layoutState);
  const effective = useEffectiveToolsets(baseToolsets, draft);
  const [selectedToolsetId, setSelectedToolsetId] = useState<string | undefined>(effective[0]?.id);
  const [newToolbarName, setNewToolbarName] = useState("");

  const sensors = useSensors(
    useSensor(PointerSensor),
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
    const source = baseById.get(toolsetId) ?? effective.find((toolset) => toolset.id === toolsetId);
    if (!source) {
      return;
    }
    setDraft((current) => {
      const result = cloneToolset(current, source);
      setSelectedToolsetId(result.toolsetId);
      return result.state;
    });
  };

  const handleCreate = () => {
    const title = newToolbarName.trim() || "New Toolbar";
    setDraft((current) => {
      const result = createUserToolset(current, { title });
      setSelectedToolsetId(result.toolsetId);
      return result.state;
    });
    setNewToolbarName("");
  };

  return (
    <div className="customize-toolbars-backdrop" role="presentation" onClick={onClose}>
      <div
        className="customize-toolbars-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Customize Toolbars"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="customize-toolbars-header">
          <h2>Customize Toolbars</h2>
          <button type="button" className="customize-toolbars-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="customize-toolbars-body">
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
          <button type="button" className="customize-toolbars-cancel" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="customize-toolbars-apply" onClick={() => onApply(draft)}>
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}
