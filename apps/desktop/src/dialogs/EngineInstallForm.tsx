import { useEffect, useRef } from "react";
import { detectDialogPlatform, type DialogPlatform, type EngineInstallAction, type EngineInstallSnapshot } from "./dialogProtocol";

const gigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;
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
  return <section role="dialog" aria-label={snapshot.title} style={{ padding: 20 }}>
    <h2>{snapshot.title}</h2>
    <p>{snapshot.engineName}</p>
    <p>Requested by {snapshot.pluginName} ({snapshot.pluginId})</p>
    <p>{snapshot.disclosure}</p>
    <p>Installation needs {gigabytes(snapshot.requiredDiskBytes)}. Free space: {gigabytes(snapshot.freeDiskBytes)}.</p>
    {state.status === "broken" ? <p role="alert">{state.detail}</p> : null}
    {state.status === "failed" ? <p role="alert">{state.message}</p> : null}
    {state.status === "installed" ? <p role="status">{snapshot.engineName} is installed.</p> : null}
    {state.status === "installing" ? <div role="status">
      <p>Step {state.step} of {state.steps}: {state.phase}</p>
      <progress aria-label="Engine installation" max={state.bytesTotal || undefined} value={state.bytesTotal ? Math.min(state.bytesDone, state.bytesTotal) : undefined} />
      {state.bytesTotal ? <p>{state.estimated ? "Estimated: " : ""}{state.bytesDone.toLocaleString()} of {state.bytesTotal.toLocaleString()} bytes</p> : null}
    </div> : null}
    {error ? <p role="alert">{error}</p> : null}
    <div className="cd-page-size-buttons">
      {snapshot.buttons.includes("install") ? <button type="button" disabled={busy} onClick={() => onAction("install")}>{state.status === "broken" ? "Install engine again" : "Install"}</button> : null}
      {snapshot.buttons.includes("cancelInstall") ? <button type="button" onClick={() => onAction("cancelInstall")}>Cancel installation</button> : null}
      <button ref={close} type="button" onClick={() => onAction("close")}>Close</button>
    </div>
  </section>;
}
