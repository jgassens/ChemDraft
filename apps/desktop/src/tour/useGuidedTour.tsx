import { KEYBOARD_PREFERENCES_COMMAND_ID } from "../commands";
import { lazy, Suspense, useRef, useState } from "react";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import type { DialogCoordinator } from "../dialogs/DialogCoordinator";
import type { KeybindingScheme } from "../keybindingSettings";
import { updateShortcutPreference } from "../useShortcutPreference";
import { isDesktopRuntime } from "../window-manager";
import { TOUR_NAME_COMMAND, TOUR_SAMPLE_COMMAND, type TourAction } from "./tourCommands";
import { saveTourSeen, useAutomaticTour, type TourMode } from "./tourState";

const TourForm = lazy(() => import("./TourForm").then(module => ({ default: module.TourForm })));

export function useGuidedTour(options: {
  coordinator: () => DialogCoordinator | undefined;
  readyAndIdle: () => boolean;
  scheme: KeybindingScheme;
  platform?: ShortcutPlatform;
  mode?: TourMode;
  setStatus: (message: string) => void;
}) {
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserError, setBrowserError] = useState<string>();
  const [browserBusy, setBrowserBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const manual = useRef(false);

  const open = async (automatic: boolean) => {
    if (automatic && manual.current) return;
    if (isDesktopRuntime()) {
      const coordinator = options.coordinator();
      if (!coordinator) throw new Error("The dialog host is unavailable.");
      await coordinator.openGuidedTour(options.scheme, automatic);
    } else {
      setBrowserError(undefined);
      setBrowserOpen(true);
    }
    if (!automatic) manual.current = true;
  };

  useAutomaticTour({
    mode: options.mode,
    retry,
    idle: () => manual.current || (options.readyAndIdle() && !options.coordinator()?.hasOpenDialog()
      && !document.querySelector('[role="dialog"]:not([hidden]), [aria-modal="true"]:not([hidden])')),
    open: () => open(true),
    onError: error => options.setStatus(`Could not open the tour. ${String(error)}`)
  });

  const completeOrRun = async (action: TourAction, commands: {
    invoke: (id: string) => Promise<unknown>;
    has: (id: string) => boolean;
  }) => {
    switch (action.action) {
      case "cancel": case "finish":
        await saveTourSeen();
        setBrowserOpen(false);
        break;
      case "chooseShortcuts":
        await updateShortcutPreference(action.scheme);
        break;
      case "tryTourCommand":
        if (action.command === TOUR_NAME_COMMAND && !commands.has(TOUR_NAME_COMMAND)) {
          throw new Error("Add Name to Structure from Plugins > Add or Remove Plugins, then try again.");
        }
        // Put commands with an insertion or analysis target in the practice drawing first.
        if (action.command !== TOUR_SAMPLE_COMMAND && action.command !== KEYBOARD_PREFERENCES_COMMAND_ID) {
          await commands.invoke(TOUR_SAMPLE_COMMAND);
        }
        await commands.invoke(action.command);
        break;
    }
  };

  return {
    open: () => open(false),
    deferred: () => setRetry(count => count + 1),
    completeOrRun,
    renderBrowser: (onAction: (action: TourAction) => Promise<void>) => browserOpen ? (
      <div className="guided-tour-preview">
        <Suspense fallback={<p>Opening tour…</p>}>
          <TourForm scheme={options.scheme} platform={options.platform} busy={browserBusy} error={browserError}
            onAction={action => {
              setBrowserError(undefined);
              setBrowserBusy(true);
              void onAction(action).catch(error => setBrowserError(error instanceof Error ? error.message : String(error)))
                .finally(() => setBrowserBusy(false));
            }} />
        </Suspense>
      </div>
    ) : null
  };
}
