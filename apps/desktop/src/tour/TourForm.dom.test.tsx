// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TourForm } from "./TourForm";
import { tourShortcutChoices, tourSteps } from "./tourSteps";
import { PLUGIN_AUTHORING_GUIDE_URL, TOUR_PLUGIN_COMMANDS } from "./tourCommands";
import { parseDialogMessage } from "../dialogs/dialogProtocol";
import { buildAppMenuModel, flattenAppMenuCommands } from "../appMenu";

let container: HTMLDivElement;
let root: Root;
const platforms = ["macos", "windows"] as const;
const schemes = ["chemdraft", "chemdraw"] as const;
// Every plugin a step can demonstrate, installed and enabled.
const allPlugins = TOUR_PLUGIN_COMMANDS;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe.each(platforms)("guided tour on %s", platform => {
  const button = (text: string) => [...container.querySelectorAll("button")].find(button => button.textContent === text)!;
  const click = (text: string) => act(() => button(text).click());

  it("offers a one-click Skip on every step and Finish on the last step", () => {
    const onAction = vi.fn();
    act(() => root.render(<TourForm scheme="chemdraft" platform={platform} plugins={allPlugins} onAction={onAction} />));
    expect(button("Back").disabled).toBe(true);
    for (let step = 1; step <= 9; step++) {
      expect(container.textContent).toContain(`Step ${step} of 9`);
      expect(button("Skip tour").disabled).toBe(false);
      click("Skip tour");
      expect(onAction).toHaveBeenLastCalledWith({ action: "cancel" });
      if (step < 9) click("Next");
    }
    expect(onAction).toHaveBeenCalledTimes(9);
    click("Back");
    expect(container.textContent).toContain("Step 8 of 9");
    click("Next");
    click("Finish");
    expect(onAction).toHaveBeenLastCalledWith({ action: "finish" });
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
    expect(onAction).toHaveBeenLastCalledWith({ action: "cancel" });
  });

  it("offers real commands and displays platform-specific shortcut examples", () => {
    const onAction = vi.fn();
    act(() => root.render(<TourForm scheme="chemdraft" platform={platform} plugins={allPlugins} onAction={onAction} />));
    click("Next");
    const radios = container.querySelectorAll<HTMLInputElement>("input[type=radio]");
    expect(radios[0].checked).toBe(true);
    act(() => radios[1].click());
    expect(onAction).toHaveBeenLastCalledWith({ action: "chooseShortcuts", scheme: "chemdraw" });
    expect(container.textContent).toContain("Classic desktop-compatible");
    const choices = tourShortcutChoices(platform);
    expect(choices.map(choice => choice.examples.length)).toEqual([5, 5]);
    expect(choices.map(choice => choice.examples[0].key)).toEqual(["M", "X"]);
    expect(choices.map(choice => choice.examples.at(-1)?.key)).toEqual(platform === "macos" ? ["⌘S", "⌘S"] : ["Ctrl+S", "Ctrl+S"]);

    expect(container.textContent).toContain("Preferences > Keyboard");
    click("Try it");
    expect(onAction).toHaveBeenLastCalledWith({ action: "tryTourCommand", command: "view.openKeyboardPreferences" });

    for (const command of ["help.tour.openSample", "status", "plugins", "plugin.opsinNameToStructure.convert", "analyze.molecularProperties"]) {
      click("Next");
      if (command === "status" || command === "plugins") {
        // The status-bar card is text only. The plugins card explains plugins before the tour shows one;
        // it has no Try it either.
        expect(container.querySelector("h1")!.textContent).toBe(command === "status" ? "Keep an eye on the status bar" : "Add features with plugins");
        expect(button("Try it")).toBeUndefined();
        continue;
      }
      click("Try it");
      expect(onAction).toHaveBeenLastCalledWith({ action: "tryTourCommand", command });
    }
    click("Next");
    click("Next");
    const text = container.textContent;
    expect(text).toContain(platform === "macos" ? "Choose ChemDraft > Settings… (⌘,)" : "Choose File > Preferences… (Ctrl+,)");
  });

  it("opens the plugin authoring guide from a real link, by click or Enter, without navigating the tour", () => {
    const onAction = vi.fn();
    act(() => root.render(<TourForm scheme="chemdraft" platform={platform} plugins={allPlugins} onAction={onAction} />));
    while (container.querySelector("h1")!.textContent !== "Add features with plugins") click("Next");
    const links = container.querySelectorAll<HTMLAnchorElement>(".guided-tour-url a");
    expect(links).toHaveLength(1);
    const link = links[0]!;
    // The user still sees the same address, now as a link to it.
    expect(link.textContent).toBe(PLUGIN_AUTHORING_GUIDE_URL);
    expect(link.getAttribute("href")).toBe(PLUGIN_AUTHORING_GUIDE_URL);
    expect(container.querySelector(".guided-tour-url")!.textContent).toBe(PLUGIN_AUTHORING_GUIDE_URL);

    const location = window.location.href;
    const clicks: boolean[] = [];
    const record = (event: MouseEvent) => clicks.push(event.defaultPrevented);
    document.addEventListener("click", record);
    try {
      act(() => link.click());
      expect(onAction).toHaveBeenCalledTimes(1);
      expect(onAction).toHaveBeenLastCalledWith({ action: "openGuide", url: PLUGIN_AUTHORING_GUIDE_URL });

      // A browser activates a focused link on Enter by firing click, unless the keydown was cancelled.
      // jsdom does not, so do what the browser does: the form must neither cancel Enter nor act on it twice.
      act(() => {
        link.focus();
        if (link.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))) link.click();
        link.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }));
      });
      expect(document.activeElement).toBe(link);
      expect(onAction).toHaveBeenCalledTimes(2);
      expect(onAction).toHaveBeenLastCalledWith({ action: "openGuide", url: PLUGIN_AUTHORING_GUIDE_URL });
    } finally {
      document.removeEventListener("click", record);
    }
    // Both clicks were cancelled, so the tour window never followed the link.
    expect(clicks).toEqual([true, true]);
    expect(window.location.href).toBe(location);
    expect(container.querySelector("h1")!.textContent).toBe("Add features with plugins");
  });

  it("opens the guide only through the host for modified clicks, middle-clicks and drags", () => {
    const onAction = vi.fn();
    act(() => root.render(<TourForm scheme="chemdraft" platform={platform} plugins={allPlugins} onAction={onAction} />));
    while (container.querySelector("h1")!.textContent !== "Add features with plugins") click("Next");
    const link = container.querySelector<HTMLAnchorElement>(".guided-tour-url a")!;
    const location = window.location.href;
    const guide = { action: "openGuide", url: PLUGIN_AUTHORING_GUIDE_URL };
    // dispatchEvent returns false when the event's default action was cancelled.
    const fire = (event: Event) => { let followed = true; act(() => { followed = link.dispatchEvent(event); }); return followed; };

    // Cmd-, Ctrl- and Shift-click are clicks: cancelled, and sent to the host once each.
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }]) {
      onAction.mockClear();
      expect(fire(new MouseEvent("click", { ...modifier, button: 0, bubbles: true, cancelable: true })), JSON.stringify(modifier)).toBe(false);
      expect(onAction.mock.calls).toEqual([[guide]]);
    }

    // A middle-click arrives as auxclick: cancelled, and sent to the host like a click.
    onAction.mockClear();
    expect(fire(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }))).toBe(false);
    expect(onAction.mock.calls).toEqual([[guide]]);
    // Any other non-primary button is cancelled and does nothing.
    onAction.mockClear();
    expect(fire(new MouseEvent("auxclick", { button: 2, bubbles: true, cancelable: true }))).toBe(false);
    expect(onAction).not.toHaveBeenCalled();

    // The link cannot be dragged out to another window or dropped back on this one.
    expect(link.getAttribute("draggable")).toBe("false");
    expect(fire(new MouseEvent("dragstart", { bubbles: true, cancelable: true }))).toBe(false);
    expect(onAction).not.toHaveBeenCalled();

    expect(window.location.href).toBe(location);
    expect(container.querySelector("h1")!.textContent).toBe("Add features with plugins");
  });

  it("names the Preferences menu item exactly as the menu bar labels it", () => {
    const sections = buildAppMenuModel({
      platform, rulersVisible: true, crosshairsVisible: true, canUndo: false, canRedo: false,
      hasSelection: false, hasSelectedMolecule: false, toolbars: []
    });
    const owner = sections.find(section => section.items.some(item => item.kind === "command" && item.commandId === "view.togglePreferences"))!;
    const item = flattenAppMenuCommands([owner]).find(command => command.commandId === "view.togglePreferences")!;
    expect([owner.label, item.label, item.shortcut]).toEqual(platform === "macos" ? ["ChemDraft", "Settings…", "⌘,"] : ["File", "Preferences…", "Ctrl+,"]);
    for (const scheme of schemes) {
      expect(tourSteps(scheme, platform).at(-1)!.text).toContain(`Choose ${owner.label} > ${item.label} (${item.shortcut}) to open Preferences.`);
    }
    if (platform !== "macos") {
      // Off macOS the native File menu shows the native item's own title.
      const source = readFileSync(resolve("apps", "desktop", "src-tauri", "src", "lib.rs"), "utf8");
      const native = source.split("fn preferences_menu_item<R: Runtime>")[1]!.split("fn create_view_menu")[0]!;
      expect(native).toContain(`"${item.label}",`);
    }
  });

  it("clears a step's error when the step changes, forward or back", () => {
    const onAction = vi.fn();
    const render = (error?: string) => act(() => root.render(<TourForm scheme="chemdraft" platform={platform} plugins={allPlugins} onAction={onAction} error={error} />));
    const alert = () => container.querySelector('[role="alert"]')?.textContent;
    const missing = "Add Name to Structure from Plugins > Add or Remove Plugins, then try again.";
    render();
    for (let step = 1; step < 6; step++) click("Next");
    expect(container.textContent).toContain("Step 6 of 9");
    click("Try it");
    render(missing);
    expect(alert()).toBe(missing);

    click("Next");
    expect(container.textContent).toContain("Step 7 of 9");
    expect(alert()).toBeUndefined();
    click("Back");
    expect(container.textContent).toContain("Step 6 of 9");
    expect(alert()).toBeUndefined();

    // A new action shows its own error again; leaving that step backward clears it too.
    click("Try it");
    render(undefined);
    render(missing);
    expect(alert()).toBe(missing);
    click("Back");
    expect(alert()).toBeUndefined();

    // A late error from an action sent on an earlier step does not appear on the new one.
    render(undefined);
    click("Next");
    click("Try it");
    click("Next");
    render("Late failure");
    expect(container.textContent).toContain("Step 7 of 9");
    expect(alert()).toBeUndefined();
    click("Try it");
    render(undefined);
    render("Inspector failed");
    expect(alert()).toBe("Inspector failed");
  });

  it("keeps public copy free of other drawing product names", () => {
    const banned = /chemdraw|marvin(?:sketch)?|isischem|isis\/draw|acd\/chemsketch|chemsketch|ketcher|chemwindow|bkchem/i;
    for (const scheme of schemes) {
      for (const step of [...tourSteps(scheme, platform), ...tourSteps(scheme, platform, allPlugins)]) {
        expect(step.title + step.text).not.toMatch(banned);
      }
    }
  });
});

const envelope = {
  protocolVersion: 1, ownerWindowId: "main", documentTabId: "guidedTour", dialogKind: "guidedTour",
  sessionId: "session", requestId: "request", snapshotRevision: 1
};

it("keeps TypeScript tour commands in sync with the native allowlist", () => {
  const source = readFileSync(resolve("apps", "desktop", "src-tauri", "src", "dialog_windows.rs"), "utf8");
  const nativeEnum = source.match(/enum GuidedTourCommand\s*\{([^}]*)\}/)?.[1] ?? "";
  const nativeCommands = new Set([...nativeEnum.matchAll(/#\[serde\(rename = "([^"]+)"\)\]/g)].map(match => match[1]!));
  const tourCommands = new Set(platforms
    .flatMap(platform => schemes.flatMap(scheme => tourSteps(scheme, platform, TOUR_PLUGIN_COMMANDS)))
    .map(step => step.tryCommand)
    .filter(command => command !== undefined));
  expect(nativeCommands).toEqual(tourCommands);
  for (const command of tourCommands) {
    expect(parseDialogMessage({ ...envelope, type: "action", data: { action: "tryTourCommand", command } })).toBeDefined();
  }
});

it("keeps the plugin authoring guide address the same in TypeScript and in the native allowlist", () => {
  const source = readFileSync(resolve("apps", "desktop", "src-tauri", "src", "dialog_windows.rs"), "utf8");
  const native = [...source.matchAll(/const GUIDED_TOUR_GUIDE_URL: &str =\s*"([^"]+)";/g)].map(match => match[1]);
  expect(native).toEqual([PLUGIN_AUTHORING_GUIDE_URL]);
  // The step that shows a link shows exactly this address.
  const urls = new Set(platforms.flatMap(platform => schemes.flatMap(scheme => [
    ...tourSteps(scheme, platform), ...tourSteps(scheme, platform, TOUR_PLUGIN_COMMANDS)
  ])).flatMap(step => step.url ? [step.url] : []));
  expect([...urls]).toEqual([PLUGIN_AUTHORING_GUIDE_URL]);
});

it("lets the tour window send the guide link to the native host, which checks the exact address", () => {
  // sendDialogMessage refuses anything this parser rejects, so the link must pass it to reach Rust.
  // Rust opens only its one allowed address and never relays the action to the document window.
  expect(parseDialogMessage({ ...envelope, type: "action", data: { action: "openGuide", url: PLUGIN_AUTHORING_GUIDE_URL } })).toBeDefined();
  for (const data of [
    { action: "openGuide" },
    { action: "openGuide", url: 1 },
    { action: "openGuide", url: "" },
    { action: "openGuide", url: "x".repeat(2049) },
    { action: "openGuide", url: PLUGIN_AUTHORING_GUIDE_URL, extra: true }
  ]) {
    expect(parseDialogMessage({ ...envelope, type: "action", data }), JSON.stringify(data).slice(0, 80)).toBeUndefined();
  }
});

it("rejects invalid tour actions in the TypeScript dialog protocol", () => {
  expect(parseDialogMessage({ ...envelope, type: "snapshot", data: { title: "Take the Tour", scheme: "chemdraft", automatic: true } })).toBeDefined();
  for (const data of [
    { action: "tryTourCommand", command: "document.save" },
    { action: "chooseShortcuts", scheme: "other" },
    { action: "cancel", command: "document.save" }
  ]) {
    expect(parseDialogMessage({ ...envelope, type: "action", data })).toBeUndefined();
  }
});

// The owner's bug: on step 2 the Try it button sat below the fold of the fixed-size tour window.
describe.each(["macos", "windows", "linux"] as const)("tour actions above the fold on %s", platform => {
  afterEach(() => { vi.restoreAllMocks(); });
  const button = (text: string) => [...container.querySelectorAll("button")].find(item => item.textContent === text);
  const click = (text: string) => act(() => button(text)!.click());
  const rect = (width: number, height: number) => ({
    x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({})
  }) as DOMRect;
  const FOOTER = 59;
  const PADDING = 44;
  /** A stand-in for layout, which jsdom does not do: each hidden sizer step is as tall as its text, the
   *  shortcut step tallest; the tour root is as tall as its content box (the larger of its own step and
   *  the reserved height), plus padding, the action row and the footer. */
  function mockLayout(width: () => number, stepHeight: (title: string) => number) {
    const ownStep = (content: Element) => stepHeight(content.querySelector(":scope > h1")!.textContent!);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.matches(".guided-tour-sizer-step")) return rect(width() - 48, stepHeight(this.querySelector("h1")!.textContent!));
      if (this.matches(".guided-tour-sizer .guided-tour-actions")) return rect(width() - 48, 44);
      if (this.matches(".guided-tour")) {
        const content = this.querySelector<HTMLElement>(":scope > .guided-tour-content")!;
        const actions = this.querySelector<HTMLElement>(":scope > .guided-tour-actions")!;
        const reserve = Number.parseFloat(content.style.getPropertyValue("--guided-tour-step-reserve")) || 0;
        const action = Number.parseFloat(actions.style.minHeight) || 0;
        // As in the browser: the text area grows to its reserve or its own step, up to its max-height.
        const ceiling = Number.parseFloat(content.style.maxHeight) || Infinity;
        return rect(width(), PADDING + Math.min(Math.max(reserve, ownStep(content)), ceiling) + action + FOOTER);
      }
      return rect(0, 0);
    });
  }
  const tallestTitle = "Choose your shortcuts";
  const stepHeight = (title: string) => title === tallestTitle ? 330 : 120 + title.length;

  for (const plugins of [[], allPlugins] as const) {
    for (const scheme of schemes) {
      it(`keeps Try it outside the scrolling text on every step (${scheme}, ${plugins.length ? "plugins" : "no plugins"})`, () => {
        act(() => root.render(<TourForm scheme={scheme} platform={platform} plugins={plugins} onAction={vi.fn()} />));
        const steps = tourSteps(scheme, platform, plugins);
        for (const [index, step] of steps.entries()) {
          expect(container.querySelector("h1")!.textContent).toBe(step.title);
          const tryIt = button("Try it");
          expect(Boolean(tryIt)).toBe(Boolean(step.tryCommand));
          if (tryIt) {
            expect(tryIt.closest(".guided-tour-content")).toBeNull();
            expect(tryIt.closest(".guided-tour-actions")!.parentElement!.matches(".guided-tour")).toBe(true);
          }
          // Back, Next and Finish never scroll either; the hidden sizer is gone after measuring.
          for (const action of container.querySelectorAll("footer button")) expect(action.closest(".guided-tour-content")).toBeNull();
          expect(container.querySelector(".guided-tour-sizer")).toBeNull();
          if (index < steps.length - 1) click("Next");
        }
      });
    }
  }

  it("reports a content height that covers the tallest step, the same on every step", async () => {
    const { measureDialogContent } = await import("../dialogs/dialogContentFit");
    mockLayout(() => 520, stepHeight);
    const onReady = vi.fn();
    act(() => root.render(<TourForm scheme="chemdraft" platform={platform} plugins={allPlugins} onAction={vi.fn()} onReady={onReady} />));
    expect(onReady).toHaveBeenCalledTimes(1);
    const tour = onReady.mock.calls[0]![0] as HTMLElement;
    expect(tour).toBe(container.querySelector(".guided-tour"));
    const content = tour.querySelector<HTMLElement>(".guided-tour-content")!;
    expect(content.style.getPropertyValue("--guided-tour-step-reserve")).toBe("330px");
    expect(tour.querySelector<HTMLElement>(":scope > .guided-tour-actions")!.style.minHeight).toBe("44px");
    const heights = new Set<number>();
    for (let step = 1; step <= 9; step++) {
      const fit = measureDialogContent(tour)!;
      expect(fit.contentHeight).toBeGreaterThanOrEqual(PADDING + 330 + 44 + FOOTER);
      heights.add(fit.contentHeight);
      if (step < 9) click("Next");
    }
    // One height for every step: the native window never jumps between steps.
    expect([...heights]).toHaveLength(1);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("reports the capped height on every step, even one taller than the cap, and never refits between steps", async () => {
    const { measureDialogContent, observeDialogContent } = await import("../dialogs/dialogContentFit");
    const { TOUR_STEP_MAX_RESERVED_HEIGHT } = await import("./TourForm");
    const overCap = "Add features with plugins";
    mockLayout(() => 520, title => title === overCap ? TOUR_STEP_MAX_RESERVED_HEIGHT + 300 : stepHeight(title));
    const onReady = vi.fn();
    act(() => root.render(<TourForm scheme="chemdraft" platform={platform} plugins={allPlugins} onAction={vi.fn()} onReady={onReady} />));
    const tour = onReady.mock.calls[0]![0] as HTMLElement;
    const content = tour.querySelector<HTMLElement>(".guided-tour-content")!;
    expect(content.style.getPropertyValue("--guided-tour-step-reserve")).toBe(`${TOUR_STEP_MAX_RESERVED_HEIGHT}px`);
    expect(content.style.maxHeight).toBe(`${TOUR_STEP_MAX_RESERVED_HEIGHT}px`);
    const capped = PADDING + TOUR_STEP_MAX_RESERVED_HEIGHT + 44 + FOOTER;
    const initial = measureDialogContent(tour)!;
    expect(initial.contentHeight).toBe(capped);
    // The dialog host's own content observer, as DialogWindow starts it after ready.
    const refits = vi.fn();
    const stop = observeDialogContent(tour, initial, refits);
    try {
      let sawOverCap = false;
      for (let step = 1; step <= 9; step++) {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        sawOverCap ||= tour.querySelector("h1")!.textContent === overCap;
        expect(measureDialogContent(tour)!.contentHeight).toBe(capped);
        if (step < 9) click("Next");
      }
      expect(sawOverCap).toBe(true);
    } finally { stop(); }
    expect(refits).not.toHaveBeenCalled();
  });

  it("measures again for a new width, and caps the reserve so long text scrolls instead", async () => {
    const { TOUR_STEP_MAX_RESERVED_HEIGHT } = await import("./TourForm");
    let width = 520;
    let narrow = false;
    let resized: (() => void) | undefined;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resized = callback; }
      observe() {}
      disconnect() {}
    });
    mockLayout(() => width, title => narrow ? 900 : stepHeight(title));
    act(() => root.render(<TourForm scheme="chemdraft" platform={platform} plugins={allPlugins} onAction={vi.fn()} />));
    const content = () => container.querySelector<HTMLElement>(".guided-tour-content")!.style.getPropertyValue("--guided-tour-step-reserve");
    expect(content()).toBe("330px");
    act(() => resized!());
    expect(content()).toBe("330px");
    width = 360;
    narrow = true;
    act(() => resized!());
    expect(content()).toBe(`${TOUR_STEP_MAX_RESERVED_HEIGHT}px`);
    expect(container.querySelector(".guided-tour-sizer")).toBeNull();
  });
});

it("styles only the step text as the scroll container and fits the native window to it", () => {
  const css = readFileSync(resolve("apps", "desktop", "src", "tour", "TourForm.css"), "utf8");
  const rule = (selector: string) => css.split(`${selector} {`)[1]!.split("}")[0]!;
  expect(rule(".guided-tour-content")).toContain("overflow: auto");
  expect(rule(".guided-tour-actions")).toContain("flex: none");
  expect(rule(".guided-tour-actions")).not.toContain("overflow");
  expect(rule(".guided-tour-content::before")).toContain("height: var(--guided-tour-step-reserve, 0px)");
  // The ceiling TourForm sets (max-height) is the text's own height, like the reserve, not its padding box.
  expect(rule(".guided-tour-content")).toContain("box-sizing: content-box");
  expect(rule(".guided-tour-actions")).toContain("margin-top: auto");
  const source = readFileSync(resolve("apps", "desktop", "src-tauri", "src", "dialog_windows.rs"), "utf8");
  const spec = source.split(`"guidedTour" => Ok(DialogKindSpec {`)[1]!.split("}),")[0]!;
  expect(spec).toContain("fit_content: true");
  expect(spec).toContain("preserve_user_frame: false");
});
