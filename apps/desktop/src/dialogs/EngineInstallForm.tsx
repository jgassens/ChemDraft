import { useEffect, useRef } from "react";
import { installSpaceStatement, isShortOfSpace } from "./engineInstallText";
import { detectDialogPlatform, type DialogPlatform, type EngineInstallAction, type EngineInstallSnapshot } from "./dialogProtocol";

export function EngineInstallForm({ snapshot, onAction, busy = false, error, platform = detectDialogPlatform() }: {
  snapshot: EngineInstallSnapshot; onAction(action: EngineInstallAction): void;
  busy?: boolean; error?: string; platform?: DialogPlatform;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { close.current?.focus(); }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape" || ((platform === "macos" ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === "w")) {
        event.preventDefault(); event.stopPropagation(); onAction("close");
      }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [onAction, platform]);
  const state = snapshot.state;
  const short = isShortOfSpace(snapshot.requiredDiskBytes, snapshot.freeDiskBytes);
  return <section role="dialog" aria-label={snapshot.title} style={{ padding: 20 }}>
    <h2>{snapshot.engineName} needs a local engine</h2>
    <p>Requested by {snapshot.pluginName} ({snapshot.pluginId})</p>
    <p>{snapshot.disclosure}</p>
    <p role={short ? "alert" : undefined}>{installSpaceStatement(snapshot.requiredDiskBytes, snapshot.freeDiskBytes)}</p>
    {state.status === "broken" ? <p role="alert">{state.detail}</p> : null}
    {state.status === "failed" ? <p role="alert">{state.message}</p> : null}
    {state.status === "installed" ? <p role="status">The {snapshot.engineName.toLowerCase()} engine is installed.</p> : null}
    {state.status === "installing" ? <div role="status">
      <p>Step {state.step} of {state.steps}: {state.phase}</p>
      <progress aria-label="Engine installation" max={state.bytesTotal || undefined} value={state.bytesTotal ? Math.min(state.bytesDone, state.bytesTotal) : undefined} />
      {state.bytesTotal ? <p>{state.estimated ? "Estimated: " : ""}{state.bytesDone.toLocaleString()} of {state.bytesTotal.toLocaleString()} bytes</p> : null}
    </div> : null}
    {error ? <p role="alert">{error}</p> : null}
    <div className="cd-page-size-buttons">
      {snapshot.buttons.includes("install") ? <button type="button" disabled={busy || short} onClick={() => onAction("install")}>{state.status === "broken" ? "Install engine again" : "Install"}</button> : null}
      {snapshot.buttons.includes("cancelInstall") ? <button type="button" onClick={() => onAction("cancelInstall")}>Cancel installation</button> : null}
      <button ref={close} type="button" onClick={() => onAction("close")}>Close</button>
    </div>
  </section>;
}
