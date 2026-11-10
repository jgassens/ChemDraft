import { useLayoutEffect, useRef, useState } from "react";
import type { BracketObject } from "@chemdraft/chem-core";
import { bracketLabelPlan, transformPointForObject } from "@chemdraft/layout-engine";

/** In-place annotation editing: Enter/blur commits once, Escape cancels, IME stays intact. */
export function BracketLabelEditor({ object, onFinish }: {
  object: BracketObject; onFinish(value?: string): void;
}) {
  const plan = bracketLabelPlan(object)!;
  const [value, setValue] = useState(plan.text);
  const editor = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const finished = useRef(false);
  const finish = (value?: string) => {
    if (finished.current) return;
    finished.current = true;
    onFinish(value);
  };
  useLayoutEffect(() => { editor.current?.focus({ preventScroll: true }); editor.current?.select(); }, []);
  const point = transformPointForObject(object, { x: object.x + plan.x, y: object.y + plan.bounds.y });
  return <input ref={editor} aria-label="Repeat-unit label" data-bracket-label-editor="true" value={value} maxLength={256}
    style={{ position: "absolute", zIndex: 20, left: `calc(${point.x}px * var(--page-scale))`,
      top: `calc(${point.y}px * var(--page-scale))`, width: `calc(${Math.max(40, plan.bounds.width + 12)}px * var(--page-scale))`,
      fontFamily: plan.fontFamily, fontSize: `calc(${plan.fontSize}px * var(--page-scale))` }}
    onPointerDown={event => event.stopPropagation()} onChange={event => setValue(event.currentTarget.value)}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    onBlur={() => { if (!composing.current) finish(value); }}
    onKeyDown={event => {
      event.stopPropagation();
      if (composing.current || event.nativeEvent.isComposing) return;
      if (event.key === "Enter") { event.preventDefault(); finish(value); }
      if (event.key === "Escape") { event.preventDefault(); finish(); }
    }} />;
}
