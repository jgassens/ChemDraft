import { useEffect, useId, useRef, useState } from "react";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { useDialogContentReady } from "../dialogs/dialogContentFit";
import { detectDesktopShortcutPlatform } from "../keyboardShortcuts";
import type { AppHandoffDialogAction, AppHandoffDialogSnapshot } from "./dialogTypes";

export function AppHandoffForm({
  snapshot, onReady, onAction, busy, error, platform = detectDesktopShortcutPlatform()
}: {
  snapshot: AppHandoffDialogSnapshot;
  onReady(element: HTMLElement): void;
  onAction(action: AppHandoffDialogAction): void;
  busy: boolean;
  error?: string;
  platform?: ShortcutPlatform;
}) {
  const root = useDialogContentReady<HTMLElement>(onReady);
  const titleId = useId();
  const combinationId = useId();
  const [combination, setCombination] = useState(snapshot.mode === "confirm" ? snapshot.suggestedCombination : "");
  const escapePressed = useRef(false);
  const actionRef = useRef(onAction);
  actionRef.current = onAction;

  useEffect(() => {
    const view = root.current?.ownerDocument.defaultView;
    if (!view) return;
    const consume = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const cancel = () => actionRef.current({ action: "cancel" });
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const closeWindow = event.key.toLowerCase() === "w" &&
        (platform === "macos" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
      const macCancel = platform === "macos" && event.key === "." && event.metaKey && !event.ctrlKey;
      if (event.key === "Escape") {
        consume(event);
        escapePressed.current ||= !event.repeat;
      } else if ((closeWindow || macCancel) && !event.altKey && !event.shiftKey) {
        consume(event);
        if (!event.repeat) cancel();
      }
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !escapePressed.current) return;
      consume(event);
      escapePressed.current = false;
      cancel();
    };
    const blur = () => { escapePressed.current = false; };
    view.addEventListener("keydown", keydown, true);
    view.addEventListener("keyup", keyup, true);
    view.addEventListener("blur", blur);
    return () => {
      view.removeEventListener("keydown", keydown, true);
      view.removeEventListener("keyup", keyup, true);
      view.removeEventListener("blur", blur);
    };
  }, [platform, root]);

  return <section ref={root} role="dialog" aria-labelledby={titleId} aria-busy={busy}
    className="cd-page-size-form cd-dialog-fit">
    <div className="cd-dialog-fit-body">
      <h2 id={titleId}>{snapshot.title}</h2>
      {snapshot.mode === "confirm" ? <>
        <p>{snapshot.appName} · {snapshot.pipeline}</p>
        {snapshot.composition && <p>Input formula {snapshot.composition.formula} · {snapshot.composition.atomCount} {snapshot.composition.atomCount === 1 ? "atom" : "atoms"}</p>}
        <div className="cd-page-size-fields">
          <label htmlFor={combinationId} style={{ minWidth: 0, maxWidth: "100%" }}>
            Build combination
            <select className="native-dialog-panel-select" id={combinationId} autoFocus disabled={busy} value={combination}
              onChange={event => setCombination(event.currentTarget.value)}>
              {Object.entries(snapshot.combinations).map(([id, values]) => {
                const parameters = Object.entries(values).filter(([name]) => name !== "rebuildAs")
                  .map(([name, value]) => `${name === "topology" ? "net" : name} ${name === "repeat" ? value.replaceAll("x", "×") : value}`);
                return <option key={id} value={id}>{[id, ...parameters].join(" · ")}</option>;
              })}
            </select>
          </label>
        </div>
      </> : <>
        <p>{snapshot.appName} completed the {snapshot.combination} build.</p>
        <p>Joint twist left {snapshot.twist?.toFixed(3) ?? "unavailable"}</p>
        <p>Rebuild with {snapshot.rebuildCombination}{
          Object.entries(snapshot.rebuildChanges).map(([name, value]) =>
            ` · ${name === "topology" ? "net" : name} ${value ?? "removed"}`)
        }</p>
      </>}
      {snapshot.warnings && snapshot.warnings.length > 0 && <ul aria-label="Build warnings" tabIndex={0} style={{ overflowWrap: "anywhere" }}>
        {snapshot.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
      </ul>}
      {error && <p role="alert">{error}</p>}
    </div>
    <footer className="cd-page-size-buttons cd-dialog-fit-footer">
      <button type="button" autoFocus={snapshot.mode === "result"} disabled={busy}
        onClick={() => onAction({ action: "cancel" })}>{snapshot.mode === "confirm" ? "Cancel" : "Close"}</button>
      {snapshot.mode === "confirm"
        ? <button type="button" disabled={busy} onClick={() => onAction({ action: "confirm", combinationId: combination })}>Build</button>
        : <button type="button" disabled={busy} onClick={() => onAction({ action: "rebuild" })}>{snapshot.rebuildLabel}</button>}
    </footer>
  </section>;
}
