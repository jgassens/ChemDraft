import { useEffect } from "react";
import type { AtomProblemSnapshot } from "./dialogProtocol";
export function AtomProblemForm({ data, busy, error, onAction, onClose }: {
  data: AtomProblemSnapshot; busy: boolean; error?: string; onAction(action: AtomProblemSnapshot["fixes"][number]["action"]): void; onClose(): void;
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" || (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w") { event.preventDefault(); onClose(); } };
    document.addEventListener("keydown", close); return () => document.removeEventListener("keydown", close);
  }, [onClose]);
  return <section role="dialog" aria-modal="false" aria-label="Atom problem" className="cd-page-size-form cd-dialog-fit">
    <div className="cd-dialog-fit-body">
      <h2>Atom problem</h2><p>{data.explanation}</p>
      {error && <p role="alert">{error}</p>}
    </div>
    <div className="cd-page-size-buttons cd-dialog-fit-footer" style={{ flexWrap: "wrap" }}>
      {data.fixes.map(fix => <button key={fix.action} disabled={busy} onClick={() => onAction(fix.action)}>{fix.label}</button>)}
      <button onClick={onClose}>Close</button>
    </div>
  </section>;
}
