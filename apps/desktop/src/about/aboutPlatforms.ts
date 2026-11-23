// The same detection keyboardShortcuts.ts wraps as detectDesktopShortcutPlatform(), taken from the
// engine directly so the About window does not load the whole command registry.
import { detectShortcutPlatform } from "@chemdraft/shortcut-engine";
import type { AboutComponent, AboutPlatform } from "./provenanceTypes";

/** True when the component ships in the given platform's build. A component with no tag ships everywhere. */
export function shipsOnPlatform(component: Pick<AboutComponent, "platforms">, platform: AboutPlatform): boolean {
  return component.platforms === undefined || component.platforms === "all" || component.platforms.includes(platform);
}

/**
 * The components that ship in the running build. NOTICE and the dependency inventory keep listing
 * everything; only the About window narrows the list. The platform is a parameter that defaults to
 * detection (as in keyboardShortcuts.ts), so one test host can check every platform.
 */
export function componentsForPlatform<T extends Pick<AboutComponent, "platforms">>(
  components: readonly T[],
  platform: AboutPlatform = detectShortcutPlatform()
): T[] {
  return components.filter(component => shipsOnPlatform(component, platform));
}
