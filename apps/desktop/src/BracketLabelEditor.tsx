import { useEffect, useRef, useState } from "react";
import type { BracketObject } from "@chemdraft/chem-core";
import { bracketLabelLayout } from "@chemdraft/layout-engine";

/** A local draft: typing never creates per-keystroke history entries. */
export function BracketLabelEditor({ object, onCommit }: {
  object: BracketObject;
  onCommit(objectId: string, label: string): void;
}) {
  const [draft, setDraft] = useState(object.label ?? "");
  const cancelled = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef({ draft, object, onCommit });
  latest.current = { draft, object, onCommit };
  // Commit before a canvas press can deselect/unmount the editor (before browser blur).
  useEffect(() => {
    const finish = (event: globalThis.PointerEvent) => {
      if (document.activeElement !== input.current || event.target === input.current) return;
      const current = latest.current;
      if (!cancelled.current && current.draft !== (current.object.label ?? "")) {
        current.onCommit(current.object.id, current.draft);
      }
    };
    window.addEventListener("pointerdown", finish, true);
    return () => window.removeEventListener("pointerdown", finish, true);
  }, []);
  useEffect(() => { setDraft(object.label ?? ""); }, [object.id, object.label]);
  const layout = bracketLabelLayout(object);
  return <input ref={input} className="bracket-label-editor" aria-label="Bracket label, repeat count, or range"
    placeholder="Enter a label, repeat count, or range" value={draft}
    style={{ left: `calc(${layout.x}px * var(--page-scale, 1))`,
      top: `calc(${layout.y - 13}px * var(--page-scale, 1))`, fontFamily: layout.fontFamily,
      fontSize: `calc(${layout.fontSize}px * var(--page-scale, 1))`,
      width: draft ? `${Math.max(3, draft.length + 1)}ch` : "32ch" }}
    onPointerDown={event => event.stopPropagation()}
    onPointerMove={event => event.stopPropagation()}
    onPointerUp={event => event.stopPropagation()}
    onContextMenu={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()}
    onFocus={() => { cancelled.current = false; }}
    onChange={event => setDraft(event.target.value)}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault(); cancelled.current = true;
        setDraft(object.label ?? ""); event.currentTarget.blur();
      } else if (event.key === "Enter") {
        event.preventDefault(); event.currentTarget.blur();
      }
    }}
    onBlur={() => {
      if (!cancelled.current && draft !== (object.label ?? "")) onCommit(object.id, draft);
      cancelled.current = false;
    }} />;
}
