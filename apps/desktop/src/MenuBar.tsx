import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

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
  const sectionButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  // openPath[0] = open top-level section id; openPath[1..] = nested submenu ids (flyout chain).
  const [openPath, setOpenPath] = useState<string[]>([]);
  const [activeSectionIndex, setActiveSectionIndex] = useState(0);

  const close = useCallback(() => setOpenPath([]), []);

  const afterRender = useCallback((callback: () => void) => {
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(callback);
    } else {
      window.setTimeout(callback, 0);
    }
  }, []);

  const restoreSectionFocus = useCallback(
    (sectionId = openPath[0]) => {
      if (!sectionId) return;
      afterRender(() => sectionButtonRefs.current.get(sectionId)?.focus());
    },
    [afterRender, openPath]
  );

  const closeAndRestore = useCallback(() => {
    const sectionId = openPath[0];
    close();
    restoreSectionFocus(sectionId);
  }, [close, openPath, restoreSectionFocus]);

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
      const sectionId = openPath[0];
      close();
      onInvoke(commandId);
      restoreSectionFocus(sectionId);
    },
    [close, onInvoke, openPath, restoreSectionFocus]
  );

  const focusMenuEdge = useCallback(
    (sectionId: string, edge: "first" | "last" = "first") => {
      afterRender(() => {
        const sectionButton = sectionButtonRefs.current.get(sectionId);
        const section = sectionButton?.parentElement;
        const menu = section?.querySelector<HTMLUListElement>(":scope > ul[role='menu']");
        const buttons = menu ? directEnabledMenuButtons(menu) : [];
        buttons[edge === "first" ? 0 : buttons.length - 1]?.focus();
      });
    },
    [afterRender]
  );

  const moveAcrossSections = useCallback(
    (fromSectionId: string, delta: number, focusMenu: boolean) => {
      if (sections.length === 0) return;
      const from = Math.max(0, sections.findIndex((section) => section.id === fromSectionId));
      const next = (from + delta + sections.length) % sections.length;
      const section = sections[next];
      setActiveSectionIndex(next);
      setOpenPath((current) => (current.length > 0 || focusMenu ? [section.id] : current));
      if (focusMenu) {
        focusMenuEdge(section.id);
      } else {
        afterRender(() => sectionButtonRefs.current.get(section.id)?.focus());
      }
    },
    [afterRender, focusMenuEdge, sections]
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
        event.preventDefault();
        closeAndRestore();
      }
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openPath.length, close, closeAndRestore]);

  const onSectionKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, sectionId: string) => {
      switch (event.key) {
        case "ArrowRight":
          event.preventDefault();
          moveAcrossSections(sectionId, 1, false);
          return;
        case "ArrowLeft":
          event.preventDefault();
          moveAcrossSections(sectionId, -1, false);
          return;
        case "ArrowDown":
        case "ArrowUp":
          event.preventDefault();
          setOpenPath([sectionId]);
          focusMenuEdge(sectionId, event.key === "ArrowDown" ? "first" : "last");
          return;
        case "Home":
          event.preventDefault();
          moveAcrossSections(sectionId, -sections.findIndex((section) => section.id === sectionId), false);
          return;
        case "End":
          event.preventDefault();
          moveAcrossSections(sectionId, sections.length - 1 - sections.findIndex((section) => section.id === sectionId), false);
          return;
      }
    },
    [focusMenuEdge, moveAcrossSections, sections]
  );

  const onMenuItemKeyDown = useCallback(
    (
      event: ReactKeyboardEvent<HTMLButtonElement>,
      sectionId: string,
      depth: number,
      submenuId?: string
    ) => {
      const currentButton = event.currentTarget;
      const currentMenu = currentButton.parentElement?.parentElement;
      if (!(currentMenu instanceof HTMLUListElement)) return;
      const buttons = directEnabledMenuButtons(currentMenu);
      const currentIndex = buttons.indexOf(currentButton);
      const focusAt = (index: number) => buttons[(index + buttons.length) % buttons.length]?.focus();

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          focusAt(currentIndex + 1);
          return;
        case "ArrowUp":
          event.preventDefault();
          focusAt(currentIndex - 1);
          return;
        case "Home":
          event.preventDefault();
          buttons[0]?.focus();
          return;
        case "End":
          event.preventDefault();
          buttons[buttons.length - 1]?.focus();
          return;
        case "ArrowRight":
          event.preventDefault();
          if (submenuId) {
            setBranch(depth, submenuId);
            afterRender(() => {
              const submenu = currentButton.parentElement?.querySelector<HTMLUListElement>(":scope > ul[role='menu']");
              directEnabledMenuButtons(submenu)[0]?.focus();
            });
          } else if (depth === 1) {
            moveAcrossSections(sectionId, 1, true);
          }
          return;
        case "ArrowLeft":
          event.preventDefault();
          if (depth > 1) {
            const parentItem = currentMenu.parentElement;
            const parentButton = parentItem?.querySelector<HTMLButtonElement>(":scope > button[role='menuitem']");
            setBranch(depth - 1);
            afterRender(() => parentButton?.focus());
          } else {
            moveAcrossSections(sectionId, -1, true);
          }
          return;
        case "Escape":
          event.preventDefault();
          event.stopPropagation();
          closeAndRestore();
          return;
        case "Tab":
          close();
          return;
      }
    },
    [afterRender, close, closeAndRestore, moveAcrossSections, setBranch]
  );

  const renderItems = (items: readonly AppMenuItem[], depth: number, sectionId: string) => (
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
                onKeyDown={(event) => onMenuItemKeyDown(event, sectionId, depth, item.id)}
              >
                <span className="menu-item-check" aria-hidden="true" />
                <span className="menu-item-label">{item.label}</span>
                <span className="menu-item-shortcut menu-item-caret" aria-hidden="true">
                  ›
                </span>
              </button>
              {submenuOpen ? renderItems(item.items, depth + 1, sectionId) : null}
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
              onKeyDown={(event) => onMenuItemKeyDown(event, sectionId, depth)}
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
                tabIndex={indexForSection(sections, section.id) === activeSectionIndex ? 0 : -1}
                ref={(node) => {
                  if (node) sectionButtonRefs.current.set(section.id, node);
                  else sectionButtonRefs.current.delete(section.id);
                }}
                onClick={() => toggleSection(section.id)}
                onPointerEnter={() => focusSection(section.id)}
                onFocus={() => setActiveSectionIndex(indexForSection(sections, section.id))}
                onKeyDown={(event) => onSectionKeyDown(event, section.id)}
              >
                {section.label}
              </button>
              {open ? renderItems(section.items, 1, section.id) : null}
            </div>
          );
        })}
      </nav>
    </header>
  );
}

function indexForSection(sections: readonly AppMenuSection[], sectionId: string): number {
  return Math.max(0, sections.findIndex((section) => section.id === sectionId));
}

function directEnabledMenuButtons(menu: HTMLUListElement | null | undefined): HTMLButtonElement[] {
  if (!menu) return [];
  return Array.from(menu.children)
    .map((child) => child.firstElementChild)
    .filter((element): element is HTMLButtonElement => element instanceof HTMLButtonElement && !element.disabled);
}
