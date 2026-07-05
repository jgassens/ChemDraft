import { useCallback, useEffect, useRef, useState } from "react";

import type { AppMenuItem, AppMenuSection } from "./appMenu";

export interface MenuBarProps {
  sections: readonly AppMenuSection[];
  onInvoke: (commandId: string) => void;
  /** Brand label shown at the left of the bar. */
  brand?: string;
}

/**
 * The in-viewport application menu bar for the browser build. It renders the shared `appMenu`
 * model and dispatches each item through `onInvoke`, which the host wires to the same frontend
 * command registry the native desktop menu routes to. See `appMenu.ts` for the model + the
 * native-parity contract.
 */
export function MenuBar({ sections, onInvoke, brand = "ChemDraft" }: MenuBarProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  // openPath[0] = open top-level section id; openPath[1..] = nested submenu ids (flyout chain).
  const [openPath, setOpenPath] = useState<string[]>([]);

  const close = useCallback(() => setOpenPath([]), []);

  const toggleSection = useCallback((sectionId: string) => {
    setOpenPath((current) => (current[0] === sectionId ? [] : [sectionId]));
  }, []);

  const focusSection = useCallback((sectionId: string) => {
    // Once a menu is open, moving across the bar switches menus (classic menu-bar behavior).
    setOpenPath((current) => (current.length === 0 || current[0] === sectionId ? current : [sectionId]));
  }, []);

  // Open the submenu at `depth` (replacing any deeper flyout); a plain item closes deeper flyouts.
  const setBranch = useCallback((depth: number, submenuId?: string) => {
    setOpenPath((current) => {
      const base = current.slice(0, depth);
      return submenuId ? [...base, submenuId] : base;
    });
  }, []);

  const invoke = useCallback(
    (commandId: string) => {
      close();
      onInvoke(commandId);
    },
    [close, onInvoke]
  );

  useEffect(() => {
    if (openPath.length === 0) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        close();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openPath.length, close]);

  const renderItems = (items: readonly AppMenuItem[], depth: number) => (
    <ul className={depth === 1 ? "menu-dropdown" : "menu-dropdown menu-flyout"} role="menu">
      {items.map((item) => {
        if (item.kind === "separator") {
          return <li key={item.id} className="menu-dropdown-separator" role="separator" />;
        }

        if (item.kind === "submenu") {
          const submenuOpen = openPath[depth] === item.id;
          return (
            <li
              key={item.id}
              className={["menu-dropdown-item", "menu-has-submenu", submenuOpen ? "is-open" : ""]
                .filter(Boolean)
                .join(" ")}
              role="none"
              onPointerEnter={() => setBranch(depth, item.id)}
            >
              <button
                type="button"
                role="menuitem"
                className="menu-dropdown-button"
                aria-haspopup="menu"
                aria-expanded={submenuOpen}
                onClick={() => setBranch(depth, submenuOpen ? undefined : item.id)}
              >
                <span className="menu-item-check" aria-hidden="true" />
                <span className="menu-item-label">{item.label}</span>
                <span className="menu-item-shortcut menu-item-caret" aria-hidden="true">
                  ›
                </span>
              </button>
              {submenuOpen ? renderItems(item.items, depth + 1) : null}
            </li>
          );
        }

        const checkable = item.checked !== undefined;
        return (
          <li key={item.id} className="menu-dropdown-item" role="none" onPointerEnter={() => setBranch(depth)}>
            <button
              type="button"
              role={checkable ? "menuitemcheckbox" : "menuitem"}
              aria-checked={checkable ? item.checked : undefined}
              aria-disabled={item.enabled ? undefined : true}
              disabled={!item.enabled}
              className="menu-dropdown-button"
              data-command-id={item.commandId}
              onClick={() => item.enabled && invoke(item.commandId)}
            >
              <span className="menu-item-check" aria-hidden="true">
                {item.checked ? "✓" : ""}
              </span>
              <span className="menu-item-label">{item.label}</span>
              {item.shortcut ? <span className="menu-item-shortcut">{item.shortcut}</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <header className="menu-bar" ref={rootRef}>
      <span className="brand">{brand}</span>
      <nav className="menu" role="menubar" aria-label="Application menu">
        {sections.map((section) => {
          const open = openPath[0] === section.id;
          return (
            <div key={section.id} className={["menu-section", open ? "is-open" : ""].filter(Boolean).join(" ")}>
              <button
                type="button"
                role="menuitem"
                className="menu-section-button"
                aria-haspopup="menu"
                aria-expanded={open}
                data-menu-section={section.id}
                onClick={() => toggleSection(section.id)}
                onPointerEnter={() => focusSection(section.id)}
              >
                {section.label}
              </button>
              {open ? renderItems(section.items, 1) : null}
            </div>
          );
        })}
      </nav>
    </header>
  );
}
