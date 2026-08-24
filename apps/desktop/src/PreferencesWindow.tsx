import { useEffect, useState } from "react";
import {
  loadSpin3dSettings,
  saveSpin3dSettings,
  type Spin3dEnginePreference,
  type Spin3dForceField,
  type Spin3dRefinementMode,
  type Spin3dSettings
} from "./spin3dSettings";
import {
  loadKeybindingSettings,
  saveKeybindingSettings,
  type KeybindingScheme,
  type KeybindingSettings
} from "./keybindingSettings";
import { broadcastKeybindingSettings, broadcastSpin3dSettings } from "./window-manager";

interface RadioOption<T extends string> {
  value: T;
  title: string;
  description: string;
}

const MODES: RadioOption<Spin3dRefinementMode>[] = [
  { value: "fast", title: "Fast", description: "Embedded conformer only. Fastest; least polished geometry." },
  { value: "balanced", title: "Balanced", description: "Quick force-field cleanup. Good default for large structures." },
  { value: "quality", title: "Quality", description: "Longer force-field cleanup. Best geometry." }
];

const ENGINES: RadioOption<Spin3dEnginePreference>[] = [
  { value: "auto", title: "Automatic", description: "RDKit ETKDG when available (fast), with automatic fallback to OpenChemLib. Recommended." },
  { value: "rdkit", title: "RDKit ETKDG", description: "Prefer RDKit's fast embedding. Falls back to OpenChemLib only if RDKit can't load." },
  { value: "openchemlib", title: "OpenChemLib (legacy)", description: "Force the original engine. Much slower on large rings; use only to compare geometry." }
];

const KEYBINDING_SCHEMES: RadioOption<KeybindingScheme>[] = [
  {
    value: "chemdraft",
    title: "ChemDraft",
    description: "The native ChemDraft shortcuts. Recommended for new users."
  },
  {
    value: "chemdraw",
    title: "ChemDraw-compatible",
    description:
      "Shortcuts and hover hotkeys that mirror ChemDraw's defaults (Space for select, X for the bond tool, hover an atom and press 2 for a carbonyl, l for Cl, b for Br…). For users transitioning from ChemDraw."
  }
];

const FORCE_FIELDS: RadioOption<Spin3dForceField>[] = [
  { value: "mmff94s", title: "MMFF94s", description: "Default planar MMFF variant. Helps aromatics, amides, and conjugated systems read flat." },
  { value: "mmff94", title: "MMFF94", description: "General-purpose MMFF variant. Available for comparison and compatibility." },
  { value: "uff", title: "UFF", description: "Universal Force Field. Requires the RDKit engine — OpenChemLib refines with MMFF94 regardless." }
];

interface PreferenceRadioGroupProps<T extends string> {
  legend: string;
  hint: string;
  name: string;
  options: RadioOption<T>[];
  value: T;
  onSelect: (value: T) => void;
}

function PreferenceRadioGroup<T extends string>({ legend, hint, name, options, value, onSelect }: PreferenceRadioGroupProps<T>) {
  const labelId = `pref-${name}`;
  return (
    <section className="preferences-section" aria-labelledby={labelId}>
      <h2 id={labelId}>{legend}</h2>
      <p className="preferences-section-hint">{hint}</p>
      <ul className="preferences-radio-list" role="radiogroup" aria-labelledby={labelId}>
        {options.map((option) => (
          <li key={option.value}>
            <label className="preferences-radio" data-selected={option.value === value}>
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={option.value === value}
                onChange={() => onSelect(option.value)}
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
  );
}

export function PreferencesWindow() {
  const [settings, setSettings] = useState<Spin3dSettings>(() => loadSpin3dSettings());
  const [keybindings, setKeybindings] = useState<KeybindingSettings>(() => loadKeybindingSettings());

  useEffect(() => {
    document.documentElement.classList.add("preferences-window-html");
    document.body.classList.add("preferences-window-body");
    return () => {
      document.documentElement.classList.remove("preferences-window-html");
      document.body.classList.remove("preferences-window-body");
    };
  }, []);

  // `update` is an event handler (a discrete radio click), so deriving `next` from the
  // current `settings` closure is safe and keeps the persist/broadcast side effects OUT of
  // the setState updater — a function React may invoke twice (StrictMode / concurrent
  // re-render), which would otherwise double-write localStorage and double-emit the event.
  const update = (patch: Partial<Spin3dSettings>): void => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSpin3dSettings(next);
    // Tell the document window to pick up the change live (localStorage persists it).
    void broadcastSpin3dSettings(next);
  };

  // Same discrete-event shape as `update` above — persist + broadcast stay out of the setState
  // updater so StrictMode double-invocation can't double-write or double-emit.
  const updateKeybindings = (scheme: KeybindingScheme): void => {
    const next: KeybindingSettings = { ...keybindings, scheme };
    setKeybindings(next);
    saveKeybindingSettings(next);
    // Every open window rebuilds its shortcut registry live; the main window also
    // pushes the scheme to the native menu (localStorage persists it).
    void broadcastKeybindingSettings(next);
  };

  return (
    <main className="preferences-shell">
      <header className="preferences-header">
        <h1>Preferences</h1>
      </header>

      <PreferenceRadioGroup
        legend="Keyboard shortcuts"
        hint="Which keyboard scheme the drawing tools and hover hotkeys use. Takes effect immediately."
        name="keybinding-scheme"
        options={KEYBINDING_SCHEMES}
        value={keybindings.scheme}
        onSelect={updateKeybindings}
      />

      <PreferenceRadioGroup
        legend="3D refinement"
        hint="How much force-field cleanup Spin 3D runs after embedding. Faster modes do less."
        name="spin3d-refinement-mode"
        options={MODES}
        value={settings.refinementMode}
        onSelect={(refinementMode) => update({ refinementMode })}
      />

      <PreferenceRadioGroup
        legend="Embedding engine"
        hint="Which engine generates the 3D conformer. RDKit is far faster on large, fused-ring structures."
        name="spin3d-engine"
        options={ENGINES}
        value={settings.enginePreference}
        onSelect={(enginePreference) => update({ enginePreference })}
      />

      <PreferenceRadioGroup
        legend="Force field"
        hint="Force field used for the refinement step."
        name="spin3d-force-field"
        options={FORCE_FIELDS}
        value={settings.forceField}
        onSelect={(forceField) => update({ forceField })}
      />
    </main>
  );
}
