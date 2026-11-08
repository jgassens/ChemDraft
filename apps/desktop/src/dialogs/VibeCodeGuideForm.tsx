import { useEffect, useRef } from "react";
import { VIBE_CODE_GUIDE } from "./vibeCodeGuideText";

export function VibeCodeGuideForm({ onAction, onReady }: { onAction: (action: "saveStarter" | "openPluginManager" | "cancel") => void; onReady?: (form: HTMLFormElement) => void }) {
  const form = useRef<HTMLFormElement>(null);
  const readyReported = useRef(false);
  useEffect(() => {
    if (readyReported.current || !form.current) return;
    readyReported.current = true;
    onReady?.(form.current);
  }, [onReady]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" || (event.key === "Enter" && !(event.target instanceof Element && event.target.closest("button")))) {
        event.preventDefault(); onAction("cancel");
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onAction]);
  return <form ref={form} className="cd-page-size-form cd-dialog-fit cd-vibe-guide" aria-label={VIBE_CODE_GUIDE.title}
    onSubmit={event => { event.preventDefault(); onAction("cancel"); }}>
    <div className="cd-dialog-fit-body">
    <ol>{VIBE_CODE_GUIDE.steps.map((step, index) => <li key={step}>{step}
      {index === 0 && <div><button type="button" onClick={() => onAction("saveStarter")}>Save Starter File…</button></div>}
      {index === 4 && <div><button type="button" onClick={() => onAction("openPluginManager")}>Add or Remove Plugins…</button></div>}
    </li>)}</ol>
    <p>{VIBE_CODE_GUIDE.safety}</p>
    </div>
    <div className="cd-page-size-buttons cd-dialog-fit-footer"><button type="submit">Close</button></div>
  </form>;
}
