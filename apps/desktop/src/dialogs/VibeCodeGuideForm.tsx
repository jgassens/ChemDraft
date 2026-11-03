import { useEffect } from "react";
import { VIBE_CODE_GUIDE } from "./vibeCodeGuideText";

export function VibeCodeGuideForm({ onAction, onReady }: { onAction: (action: "saveStarter" | "openPluginManager" | "cancel") => void; onReady?: () => void }) {
  useEffect(() => { onReady?.(); }, [onReady]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onAction("cancel"); } };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onAction]);
  return <section aria-label={VIBE_CODE_GUIDE.title} style={{ padding: 20, overflow: "auto" }}>
    <h1>{VIBE_CODE_GUIDE.title}</h1>
    <ol>{VIBE_CODE_GUIDE.steps.map((step, index) => <li key={step} style={{ marginBottom: 12 }}>{step}
      {index === 0 && <div><button onClick={() => onAction("saveStarter")}>Save Starter File…</button></div>}
      {index === 4 && <div><button onClick={() => onAction("openPluginManager")}>Add or Remove Plugins…</button></div>}
    </li>)}</ol>
    <p>{VIBE_CODE_GUIDE.safety}</p>
    <button onClick={() => onAction("cancel")}>Close</button>
  </section>;
}
