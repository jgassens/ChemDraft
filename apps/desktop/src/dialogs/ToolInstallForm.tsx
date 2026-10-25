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
  const needsDownload = snapshot.requiredDiskBytes > 0 && state.status !== "installed";
  const intent = snapshot.intent ?? (needsDownload ? "download" : "use");
  // The native managed-update detail is also part of the disclosure. Keep distinct
  // failures visible, without repeating the same explanation in the state/error lines.
  const detail = state.status === "broken" ? state.detail : state.status === "failed" ? state.message : undefined;
  return <section role="dialog" aria-label={snapshot.title} style={{ padding: 20 }}>
    <h2>{intent === "update" ? `Update ${snapshot.toolName}` : snapshot.toolName}</h2>
    <p>Requested by {snapshot.pluginName} ({snapshot.pluginId})</p>
    {state.status === "notInstalled" ? <p>Download from {snapshot.publisher}: version {snapshot.version}, from {snapshot.downloadHost}, {formatBytes(snapshot.downloadBytes)}.</p> : null}
    <p>{snapshot.disclosure}</p>
    {needsDownload ? <p>Needs about {formatBytes(snapshot.requiredDiskBytes)} free while installing. {snapshot.freeDiskBytes === null ? "Free space on this disk: unknown." : `Free now: ${formatBytes(snapshot.freeDiskBytes)}.`}</p> : null}
    {state.status === "consent" ? <p role="status">Allow {snapshot.pluginName} to {intent === "update" ? "update and use" : intent === "download" ? "download and use" : "use"} {snapshot.toolName}?</p> : null}
    {state.status === "installing" ? <div role="status"><p>{state.phase}</p>
      {state.bytesTotal !== undefined ? <progress aria-label="Tool installation" max={state.bytesTotal} value={Math.min(state.bytesDone ?? 0, state.bytesTotal)} /> : null}
      {state.bytesDone !== undefined || state.bytesTotal !== undefined ? <p>{(state.bytesDone ?? 0).toLocaleString()} of {(state.bytesTotal ?? 0).toLocaleString()} bytes</p> : null}
    </div> : null}
    {state.status === "installed" ? <p role="status">{snapshot.toolName} is installed.</p> : null}
    {detail && detail !== snapshot.managedUpdateDetail ? <p role="alert">{detail}</p> : null}
    {error && error !== detail && error !== snapshot.managedUpdateDetail ? <p role="alert">{error}</p> : null}
    <div className="cd-page-size-buttons">
      {snapshot.buttons.includes("install") ? <button type="button" disabled={busy} onClick={() => onAction("install")}>{intent === "update" ? "Update" : "Install"}</button> : null}
      {snapshot.buttons.includes("allow") ? <button type="button" disabled={busy} onClick={() => onAction("allow")}>{intent === "update" ? "Update" : "Allow"}</button> : null}
      {snapshot.buttons.includes("cancelInstall") ? <button type="button" onClick={() => onAction("cancelInstall")}>Cancel installation</button> : null}
      <button ref={close} type="button" onClick={() => onAction("close")}>Close</button>
    </div>
  </section>;
}
