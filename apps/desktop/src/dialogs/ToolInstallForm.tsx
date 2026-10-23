import { useEffect, useRef } from "react";
import { detectDialogPlatform, type DialogPlatform, type ToolInstallAction, type ToolInstallSnapshot } from "./dialogProtocol";

const formatBytes = (bytes: number) => bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;

export function ToolInstallForm({ snapshot, onAction, busy = false, error, platform = detectDialogPlatform() }: {
  snapshot: ToolInstallSnapshot; onAction(action: ToolInstallAction): void;
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
  const { state } = snapshot;
  return <section role="dialog" aria-label={snapshot.title} style={{ padding: 20 }}>
    <h2>{snapshot.toolName}</h2>
    <p>Requested by {snapshot.pluginName} ({snapshot.pluginId})</p>
    {state.status === "notInstalled" ? <p>Download from {snapshot.publisher}: version {snapshot.version}, from {snapshot.downloadHost}, {formatBytes(snapshot.downloadBytes)}.</p> : null}
    <p>{snapshot.disclosure}</p>
    <p>Needs about {formatBytes(snapshot.requiredDiskBytes)} free while installing. {snapshot.freeDiskBytes === null ? "Free space on this disk: unknown." : `Free now: ${formatBytes(snapshot.freeDiskBytes)}.`}</p>
    {state.status === "consent" ? <p role="status">Allow {snapshot.pluginName} to download and use {snapshot.toolName}?</p> : null}
    {state.status === "installing" ? <div role="status"><p>{state.phase}</p>
      {state.bytesTotal !== undefined ? <progress aria-label="Tool installation" max={state.bytesTotal} value={Math.min(state.bytesDone ?? 0, state.bytesTotal)} /> : null}
      {state.bytesDone !== undefined || state.bytesTotal !== undefined ? <p>{(state.bytesDone ?? 0).toLocaleString()} of {(state.bytesTotal ?? 0).toLocaleString()} bytes</p> : null}
    </div> : null}
    {state.status === "installed" ? <p role="status">{snapshot.toolName} is installed.</p> : null}
    {state.status === "failed" ? <p role="alert">{state.message}</p> : null}
    {state.status === "broken" ? <p role="alert">{state.detail}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <div className="cd-page-size-buttons">
      {snapshot.buttons.includes("install") ? <button type="button" disabled={busy} onClick={() => onAction("install")}>Install</button> : null}
      {snapshot.buttons.includes("allow") ? <button type="button" disabled={busy} onClick={() => onAction("allow")}>Allow</button> : null}
      {snapshot.buttons.includes("cancelInstall") ? <button type="button" onClick={() => onAction("cancelInstall")}>Cancel installation</button> : null}
      <button ref={close} type="button" onClick={() => onAction("close")}>Close</button>
    </div>
  </section>;
}
