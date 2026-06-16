import { useEffect, useState } from "react";
import {
  loadSpin3dSettings,
  saveSpin3dSettings,
  type Spin3dEnginePreference,
  type Spin3dForceField,
  type Spin3dRefinementMode,
  type Spin3dSettings
} from "./spin3dSettings";
import { broadcastSpin3dSettings } from "./window-manager";

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

const FORCE_FIELDS: RadioOption<Spin3dForceField>[] = [
  { value: "mmff94", title: "MMFF94", description: "General-purpose force field. Works with both engines." },
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

  useEffect(() => {
    document.documentElement.classList.add("preferences-window-html");
    document.body.classList.add("preferences-window-body");
    return () => {
      document.documentElement.classList.remove("preferences-window-html");
      document.body.classList.remove("preferences-window-body");
    };
  }, []);

  const update = (patch: Partial<Spin3dSettings>): void => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      saveSpin3dSettings(next);
      // Tell the document window to pick up the change live (localStorage persists it).
      void broadcastSpin3dSettings(next);
      return next;
    });
  };

  return (
    <main className="preferences-shell">
      <header className="preferences-header">
        <h1>Preferences</h1>
      </header>

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
