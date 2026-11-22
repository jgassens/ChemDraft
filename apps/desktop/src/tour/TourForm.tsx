import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import type { KeybindingScheme } from "../keybindingSettings";
import { detectDesktopShortcutPlatform } from "../keyboardShortcuts";
import { DIALOG_FONTS_READY_TIMEOUT_MS } from "../dialogs/dialogContentFit";
import { TOUR_TITLE, type TourAction, type TourPluginCommand } from "./tourCommands";
import { tourShortcutChoices, tourSteps } from "./tourSteps";
import "./TourForm.css";

/** The tallest step's text area reserves at most this many CSS pixels; longer text scrolls. The host
 *  also clamps the window to the screen's work area, so a small screen never gets a taller window. */
export const TOUR_STEP_MAX_RESERVED_HEIGHT = 480;

type TourStepData = ReturnType<typeof tourSteps>[number];

/** One step's scrolling content: counter, title, text, link and shortcut choice. The sizer renders every
 *  step with `ghost` set (no handlers, no focus target, its own radio groups) to measure the tallest. */
function TourStepContent({ step, index, count, scheme, platform, busy, heading, send, ghost }: {
  step: TourStepData;
  index: number;
  count: number;
  scheme: KeybindingScheme;
  platform: ShortcutPlatform;
  busy?: boolean;
  heading?: Ref<HTMLHeadingElement>;
  send?: (action: TourAction) => void;
  ghost?: boolean;
}) {
  const url = step.url;
  return (
    <>
      <p className="guided-tour-counter">Step {index + 1} of {count}</p>
      <h1 ref={heading} tabIndex={ghost ? undefined : -1}>{step.title}</h1>
      <p>{step.text}</p>
      {url ? <p className="guided-tour-url">
        {/* The link never navigates this window: the host opens the address in the system browser.
            Enter on the focused link fires this click, as it does for any link, and a Cmd/Ctrl- or
            Shift-click is a click too. A middle-click arrives as auxclick and opens the guide the same
            way; other buttons do nothing. The link cannot be dragged out or dropped elsewhere. The
            native window also refuses any navigation or new window (dialog_windows.rs). */}
        <a href={url} draggable={false}
          onClick={event => { event.preventDefault(); send?.({ action: "openGuide", url }); }}
          onAuxClick={event => { event.preventDefault(); if (event.button === 1) send?.({ action: "openGuide", url }); }}
          onDragStart={event => event.preventDefault()}>{url}</a>
      </p> : null}
      {step.shortcuts ? (
        <fieldset disabled={ghost || busy}>
          <legend>Keyboard shortcuts</legend>
          {tourShortcutChoices(platform).map(choice => (
            <label key={choice.scheme}>
              <input type="radio" name={ghost ? `tour-shortcuts-sizer-${index}` : "tour-shortcuts"} checked={scheme === choice.scheme}
                readOnly={ghost}
                onChange={ghost ? undefined : () => send?.({ action: "chooseShortcuts", scheme: choice.scheme })} />
              <span>{choice.label}
                <small>{choice.examples.map(({ label, key }) => <span key={label}>{label} <kbd>{key}</kbd></span>)}</small>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
    </>
  );
}

function fontsSettledNow(): boolean {
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  return !fonts || fonts.status === "loaded";
}

export function TourForm({
  scheme, onAction, onReady, busy, error, platform = detectDesktopShortcutPlatform(), plugins = []
}: {
  scheme: KeybindingScheme;
  onAction: (action: TourAction) => void;
  /** Called once the form has reserved room for its tallest step, with the element the native host
   *  measures (`fit_content` in dialog_windows.rs), so the window fits every step without resizing. */
  onReady?: (fitElement?: HTMLElement) => void;
  busy?: boolean;
  error?: string;
  platform?: ShortcutPlatform;
  /** Plugin commands the menus offered when the tour opened. Missing means none: never demo a plugin
   *  that might not be installed. */
  plugins?: readonly TourPluginCommand[];
}) {
  const [index, setIndex] = useState(0);
  // The step list is fixed when the tour opens. Installing or removing a plugin while it is open does
  // not add or drop steps under the user, so the step number, Back, Next and Finish stay put.
  const [openedWith] = useState(() => [...plugins]);
  // The host keeps its error until the next action, but an error belongs to the step whose action
  // raised it. Moving to another step, forward or back, clears it, including a late error from an
  // action still in flight; the next action on the new step shows errors again.
  const [errorStep, setErrorStep] = useState<number | undefined>(0);
  // Room reserved for the tallest step's content and for the action row, so moving between steps never
  // changes the measured height and the window does not jump. Measured from a hidden sizer that exists
  // only between a commit and its layout effect; remeasured once fonts settle and when the width changes.
  const [reserved, setReserved] = useState<{ step?: number; action?: number }>({});
  const [sizing, setSizing] = useState(true);
  const [fontsSettled, setFontsSettled] = useState(fontsSettledNow);
  const rootRef = useRef<HTMLElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const measuredWidth = useRef<number | undefined>(undefined);
  const readied = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const steps = tourSteps(scheme, platform, openedWith);
  const step = steps[index];
  const tryCommand = step.tryCommand;
  const visibleError = errorStep === index ? error : undefined;
  const goTo = (next: number) => { setErrorStep(undefined); setIndex(next); };
  const send = (action: TourAction) => { setErrorStep(index); onAction(action); };

  useLayoutEffect(() => {
    if (!sizing) return;
    const sizer = sizerRef.current;
    if (sizer) {
      const tallest = Math.max(0, ...[...sizer.querySelectorAll<HTMLElement>(".guided-tour-sizer-step")]
        .map(element => element.getBoundingClientRect().height));
      const action = sizer.querySelector<HTMLElement>(".guided-tour-actions")?.getBoundingClientRect().height ?? 0;
      setReserved({
        step: tallest > 0 ? Math.ceil(Math.min(tallest, TOUR_STEP_MAX_RESERVED_HEIGHT)) : undefined,
        action: action > 0 ? Math.ceil(action) : undefined
      });
    }
    measuredWidth.current = rootRef.current?.getBoundingClientRect().width;
    setSizing(false);
  }, [sizing]);

  // Web fonts change wrapping: measure again once they settle, bounded like the dialog host's own wait.
  useEffect(() => {
    if (fontsSettled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void Promise.race([
      document.fonts.ready.catch(() => undefined),
      new Promise(resolve => { timer = setTimeout(resolve, DIALOG_FONTS_READY_TIMEOUT_MS); })
    ]).then(() => {
      clearTimeout(timer);
      if (!live) return;
      setSizing(true);
      setFontsSettled(true);
    });
    return () => { live = false; clearTimeout(timer); };
  }, [fontsSettled]);

  // A narrower or wider window wraps the text differently: reserve for the new width.
  useEffect(() => {
    const element = rootRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const width = element.getBoundingClientRect().width;
      if (measuredWidth.current !== undefined && Math.abs(width - measuredWidth.current) >= 1) setSizing(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (readied.current || sizing || !fontsSettled) return;
    readied.current = true;
    onReady?.(rootRef.current ?? undefined);
  }, [onReady, sizing, fontsSettled]);
  useEffect(() => { heading.current?.focus(); }, [index]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      setErrorStep(index);
      onAction({ action: "cancel" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onAction, index]);

  // The reserve is also the text area's ceiling, on every step and in the host's intrinsic measurement
  // (dialogContentFit.ts lifts only the root's and `.cd-dialog-fit-body` heights), so a step taller than
  // TOUR_STEP_MAX_RESERVED_HEIGHT scrolls inside the text area instead of reporting a taller window.
  // The text area is `content-box`, so the ceiling, like the reserve, excludes its padding.
  const contentStyle = reserved.step === undefined ? undefined
    : { "--guided-tour-step-reserve": `${reserved.step}px`, maxHeight: `${reserved.step}px` } as CSSProperties;
  const actionStyle = reserved.action === undefined ? undefined : { minHeight: `${reserved.action}px` };

  return (
    <section ref={rootRef} className="guided-tour" role="dialog" aria-label={TOUR_TITLE}>
      {/* Only the step's text scrolls. Try it and its error sit in the action row below, and Back,
          Next and Finish in the footer, so a long step never pushes an action out of sight. */}
      <div className="guided-tour-content" style={contentStyle}>
        <TourStepContent step={step} index={index} count={steps.length} scheme={scheme} platform={platform}
          busy={busy} heading={heading} send={send} />
        {sizing ? (
          <div ref={sizerRef} className="guided-tour-sizer" aria-hidden="true" inert>
            {steps.map((item, itemIndex) => (
              <div key={itemIndex} className="guided-tour-sizer-step">
                <TourStepContent step={item} index={itemIndex} count={steps.length} scheme={scheme} platform={platform} ghost />
              </div>
            ))}
            <div className="guided-tour-actions"><button type="button" tabIndex={-1}>Try it</button></div>
          </div>
        ) : null}
      </div>
      <div className="guided-tour-actions" style={actionStyle}>
        {tryCommand ? <button type="button" disabled={busy}
          onClick={() => send({ action: "tryTourCommand", command: tryCommand })}>Try it</button> : null}
        {visibleError ? <p role="alert">{visibleError}</p> : null}
      </div>
      <footer>
        <button type="button" onClick={() => send({ action: "cancel" })}>Skip tour</button>
        <button type="button" disabled={index === 0} onClick={() => goTo(index - 1)}>Back</button>
        {index < steps.length - 1
          ? <button type="button" className="guided-tour-primary" onClick={() => goTo(index + 1)}>Next</button>
          : <button type="button" className="guided-tour-primary" disabled={busy}
              onClick={() => send({ action: "finish" })}>Finish</button>}
      </footer>
    </section>
  );
}
