import { useEffect, useState } from "react";
import {
  loadSpin3dSettings,
  saveSpin3dSettings,
  type Spin3dRefinementMode
} from "./spin3dSettings";
import { broadcastSpin3dSettings } from "./window-manager";

interface ModeOption {
  mode: Spin3dRefinementMode;
  title: string;
  description: string;
}

// "3D refinement" framing — not "force field" — because every mode here is MMFF94
// (the only engine OCL ships). Real UFF/GAFF arrive as separate options in Phase 3.
const MODES: ModeOption[] = [
  { mode: "fast", title: "Fast", description: "Embedded conformer only. Fastest; least polished geometry." },
  { mode: "balanced", title: "Balanced", description: "Quick MMFF94 cleanup. Good default for large structures." },
  { mode: "quality", title: "Quality", description: "Longer MMFF94 cleanup. Best current geometry." }
];

export function PreferencesWindow() {
  const [mode, setMode] = useState<Spin3dRefinementMode>(() => loadSpin3dSettings().refinementMode);

  useEffect(() => {
    document.documentElement.classList.add("preferences-window-html");
    document.body.classList.add("preferences-window-body");
    return () => {
      document.documentElement.classList.remove("preferences-window-html");
      document.body.classList.remove("preferences-window-body");
    };
  }, []);

  const selectMode = (next: Spin3dRefinementMode): void => {
    setMode(next);
    const settings = { refinementMode: next };
    saveSpin3dSettings(settings);
    // Tell the document window to pick up the change live (localStorage persists it).
    void broadcastSpin3dSettings(settings);
  };

  return (
    <main className="preferences-shell">
      <header className="preferences-header">
        <h1>Preferences</h1>
      </header>

      <section className="preferences-section" aria-labelledby="pref-3d-refinement">
        <h2 id="pref-3d-refinement">3D refinement</h2>
        <p className="preferences-section-hint">
          How Spin 3D refines a conformer after embedding. Faster modes do less force-field cleanup.
        </p>
        <ul className="preferences-radio-list" role="radiogroup" aria-labelledby="pref-3d-refinement">
          {MODES.map((option) => (
            <li key={option.mode}>
              <label className="preferences-radio" data-selected={option.mode === mode}>
                <input
                  type="radio"
                  name="spin3d-refinement-mode"
                  value={option.mode}
                  checked={option.mode === mode}
                  onChange={() => selectMode(option.mode)}
                />
                <span className="preferences-radio-body">
                  <strong>{option.title}</strong>
                  <small>{option.description}</small>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
