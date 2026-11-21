import { useEffect, useRef, useState } from "react";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import type { KeybindingScheme } from "../keybindingSettings";
import { detectDesktopShortcutPlatform } from "../keyboardShortcuts";
import { TOUR_TITLE, type TourAction } from "./tourCommands";
import { tourShortcutChoices, tourSteps } from "./tourSteps";
import "./TourForm.css";

export function TourForm({
  scheme, onAction, onReady, busy, error, platform = detectDesktopShortcutPlatform()
}: {
  scheme: KeybindingScheme;
  onAction: (action: TourAction) => void;
  onReady?: () => void;
  busy?: boolean;
  error?: string;
  platform?: ShortcutPlatform;
}) {
  const [index, setIndex] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const steps = tourSteps(scheme, platform);
  const step = steps[index];
  const tryCommand = step.tryCommand;

  useEffect(() => { onReady?.(); }, [onReady]);
  useEffect(() => { heading.current?.focus(); }, [index]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      onAction({ action: "cancel" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onAction]);

  return (
    <section className="guided-tour" role="dialog" aria-label={TOUR_TITLE}>
      <div className="guided-tour-content">
        <p className="guided-tour-counter">Step {index + 1} of {steps.length}</p>
        <h1 ref={heading} tabIndex={-1}>{step.title}</h1>
        <p>{step.text}</p>
        {step.shortcuts ? (
          <fieldset disabled={busy}>
            <legend>Keyboard shortcuts</legend>
            {tourShortcutChoices(platform).map(choice => (
              <label key={choice.scheme}>
                <input type="radio" name="tour-shortcuts" checked={scheme === choice.scheme}
                  onChange={() => onAction({ action: "chooseShortcuts", scheme: choice.scheme })} />
                <span>{choice.label}
                  <small>{choice.examples.map(({ label, key }) => <span key={label}>{label} <kbd>{key}</kbd></span>)}</small>
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {tryCommand ? <button type="button" disabled={busy}
          onClick={() => onAction({ action: "tryTourCommand", command: tryCommand })}>Try it</button> : null}
        {error ? <p role="alert">{error}</p> : null}
      </div>
      <footer>
        <button type="button" onClick={() => onAction({ action: "cancel" })}>Skip tour</button>
        <button type="button" disabled={index === 0} onClick={() => setIndex(index - 1)}>Back</button>
        {index < steps.length - 1
          ? <button type="button" className="guided-tour-primary" onClick={() => setIndex(index + 1)}>Next</button>
          : <button type="button" className="guided-tour-primary" disabled={busy}
              onClick={() => onAction({ action: "finish" })}>Finish</button>}
      </footer>
    </section>
  );
}
