import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { CanvasMenuItem } from "./canvasContextMenuModel";
import { popupNativeCanvasMenu } from "./nativeCanvasContextMenu";
import { isDesktopRuntime } from "./window-manager";

export interface CanvasContextMenuProps {
  items: readonly CanvasMenuItem[];
  position: { x: number; y: number };
  label: string;
  objectId?: string;
  targetKind: string;
  objectIndex?: number;
  onInvoke(commandId: string): void;
  onDismiss(): void;
  onFocusReturn?(): void;
}

/** Mounted once per opening. No HTML menu is exposed while the native popup is tracking. */
export function CanvasContextMenu(props: CanvasContextMenuProps) {
  const [fallback, setFallback] = useState(() => !isDesktopRuntime());
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let active = true;
    // Deferring the invoke lets React StrictMode discard its first effect without opening twice.
    void Promise.resolve().then(async () => {
      if (!active) return;
      const result = await popupNativeCanvasMenu(props.items, props.position);
      if (!active) return;
      if (!result) { setFallback(true); return; }
      if (!result.select(latest.current.onInvoke)) latest.current.onDismiss();
    });
    return () => { active = false; };
    // The owner keys this component by the context target and opening position. Its item model
    // is a snapshot for this popup; callback refs stay current across unrelated owner renders.
  }, []);
  return fallback ? <HtmlCanvasContextMenu {...props} /> : null;
}

function HtmlCanvasContextMenu(props: CanvasContextMenuProps) {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(props.position);
  const [open, setOpen] = useState<string>();
  const pendingFocus = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  useLayoutEffect(() => {
    const menu = root.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    setPosition({ x: Math.max(8, Math.min(props.position.x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(props.position.y, window.innerHeight - rect.height - 8)) });
    menu.querySelector<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node)) latest.current.onDismiss();
    };
    window.addEventListener("pointerdown", outside, true);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      if (menu.contains(document.activeElement) && document.hasFocus()) latest.current.onFocusReturn?.();
    };
  }, [props.position.x, props.position.y]);
  useLayoutEffect(() => {
    for (const button of root.current?.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]') ?? []) {
      button.tabIndex = button === document.activeElement ? 0 : -1;
    }
    if (pendingFocus.current) {
      const first = root.current?.querySelector<HTMLButtonElement>('.object-context-menu-flyout button:not(:disabled)');
      if (first) { first.tabIndex = 0; first.focus(); }
      pendingFocus.current = false;
    }
  });
  return <div className="object-context-menu" role="menu" ref={root} aria-label={props.label}
    data-context-object-id={props.objectId} data-context-target-kind={props.targetKind}
    data-context-layer-index={props.objectIndex !== undefined && props.objectIndex >= 0 ? props.objectIndex : undefined}
    style={{ left: `${position.x}px`, top: `${position.y}px` }}
    onContextMenu={event => {
      if ((event.target as Element).closest('input, textarea, [contenteditable="true"]')) return;
      event.preventDefault(); event.stopPropagation();
    }}
    onKeyDown={event => {
      const button = event.target instanceof HTMLButtonElement ? event.target : null;
      const menu = button?.closest<HTMLElement>('[role="menu"]');
      if (!button || !menu) return;
      const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)')]
        .filter(item => item.closest('[role="menu"]') === menu);
      const focus = (item?: HTMLButtonElement) => {
        if (!item) return;
        button.tabIndex = -1; item.tabIndex = 0; item.focus();
      };
      const index = buttons.indexOf(button);
      switch (event.key) {
        case "ArrowDown": case "ArrowUp":
          event.preventDefault(); event.stopPropagation();
          focus(buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]); break;
        case "Home": case "End":
          event.preventDefault(); event.stopPropagation();
          focus(buttons[event.key === "Home" ? 0 : buttons.length - 1]); break;
        case "ArrowRight":
          if (button.getAttribute("aria-haspopup") !== "menu") break;
          event.preventDefault(); event.stopPropagation();
          {
            const first = button.parentElement?.querySelector<HTMLButtonElement>('.object-context-menu-flyout button:not(:disabled)');
            if (first) focus(first);
            else { pendingFocus.current = true; button.click(); }
          }
          break;
        case "ArrowLeft": case "Escape":
          if (menu !== root.current) {
            event.preventDefault(); event.stopPropagation(); setOpen(undefined);
            focus(menu.parentElement?.querySelector<HTMLButtonElement>(':scope > button') ?? undefined);
          } else if (event.key === "Escape") {
            event.preventDefault(); event.stopPropagation(); props.onDismiss();
          }
          break;
        case "Tab":
          event.preventDefault(); event.stopPropagation(); props.onDismiss(); break;
        case "Delete": case "Backspace": event.preventDefault(); event.stopPropagation(); break;
        case "Enter": case " ":
          event.preventDefault(); event.stopPropagation();
          if (button.getAttribute("aria-haspopup") === "menu") pendingFocus.current = true;
          button.click(); break;
      }
    }}>
    <HtmlMenuItems items={props.items} open={open} setOpen={setOpen} onInvoke={props.onInvoke} />
  </div>;
}

function HtmlMenuItems({ items, open, setOpen, onInvoke }: {
  items: readonly CanvasMenuItem[];
  open?: string;
  setOpen(id: string | undefined): void;
  onInvoke(commandId: string): void;
}) {
  return items.map((item, index) => {
    if (item.kind === "separator") return <div key={index} className="object-context-menu-separator" role="separator" />;
    if (item.kind === "title") return <div key={index} className="object-context-menu-title">{item.label}</div>;
    if (item.kind === "command") return <button key={index} type="button" role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={item.checked} className="object-context-menu-item" data-command-id={item.commandId}
      disabled={!item.enabled} title={item.disabledReason} onClick={() => onInvoke(item.commandId)}>{item.label}</button>;
    const expanded = open === item.id;
    return <HtmlSubmenu key={item.id} item={item} expanded={expanded} setOpen={setOpen}>
      <HtmlMenuItems items={item.items} open={open} setOpen={setOpen} onInvoke={onInvoke} />
    </HtmlSubmenu>;
  });
}

function HtmlSubmenu({ item, expanded, setOpen, children }: {
  item: Extract<CanvasMenuItem, { kind: "submenu" }>;
  expanded: boolean;
  setOpen(id: string | undefined): void;
  children: React.ReactNode;
}) {
  const parent = useRef<HTMLDivElement>(null), flyout = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!expanded || !parent.current || !flyout.current) return;
    const rect = parent.current.getBoundingClientRect(), menu = flyout.current.getBoundingClientRect();
    setStyle({ ...(rect.right + menu.width + 8 > window.innerWidth ? { right: "100%" } : { left: "100%" }),
      top: `${-Math.max(0, rect.top + menu.height + 8 - window.innerHeight)}px` });
  }, [expanded]);
  const id = `canvas-${item.id}-menu`;
  return <div className="object-context-menu-submenu" ref={parent}
    onPointerEnter={() => { if (item.enabled) setOpen(item.id); }} onPointerLeave={() => setOpen(undefined)}>
    <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={expanded}
      aria-controls={expanded ? id : undefined} disabled={!item.enabled} data-context-submenu={item.id}
      className="object-context-menu-item object-context-menu-submenu-trigger"
      onClick={() => setOpen(expanded ? undefined : item.id)}>
      <span>{item.label}</span><span aria-hidden="true" className="object-context-menu-submenu-chevron">›</span>
    </button>
    {expanded ? <div id={id} role="menu" aria-label={item.ariaLabel} ref={flyout}
      className="object-context-menu object-context-menu-flyout" style={style}>{children}</div> : null}
  </div>;
}
