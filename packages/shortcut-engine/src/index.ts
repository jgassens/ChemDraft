export type ShortcutPlatform = "macos" | "windows" | "linux";
export type ShortcutModifier = "Alt" | "Ctrl" | "Meta" | "Shift";

export interface CommandShortcut {
  commandId: string;
  keys: readonly string[];
  platform?: ShortcutPlatform;
  when?: string;
}

export interface CommandShortcutSource {
  id: string;
  shortcut?: string;
  defaultShortcut?: string;
  enabled?: boolean;
}

export interface KeyboardEventLike {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
  repeat?: boolean;
  target?: EventTarget | null;
}

export interface ShortcutRegistryOptions {
  platform?: ShortcutPlatform;
}

export interface NormalizedShortcut {
  commandId: string;
  key: string;
  modifiers: readonly ShortcutModifier[];
  platform?: ShortcutPlatform;
  when?: string;
}

export interface ShortcutConflict {
  chord: string;
  commandIds: readonly string[];
}

export interface ShortcutRegistry {
  list(): NormalizedShortcut[];
  conflicts(): ShortcutConflict[];
  resolve(input: KeyboardEventLike): string | undefined;
}

const modifierOrder: readonly ShortcutModifier[] = ["Ctrl", "Alt", "Shift", "Meta"];

export function describeShortcut(shortcut: CommandShortcut): string {
  return shortcut.keys.join("+");
}

export function parseShortcutDisplay(display: string): string[] {
  const keys: string[] = [];
  let current = "";

  for (const character of display.trim()) {
    if (character === "+") {
      if (current) {
        keys.push(current);
        current = "";
        continue;
      }

      keys.push("+");
      continue;
    }

    current += character;
  }

  if (current) {
    keys.push(current);
  }

  return keys.filter((key) => key.length > 0);
}

export function shortcutsFromCommands(commands: readonly CommandShortcutSource[]): CommandShortcut[] {
  return commands
    .filter((command) => command.enabled !== false)
    .flatMap((command) => {
      const display = command.shortcut ?? command.defaultShortcut;
      if (!display) {
        return [];
      }

      return [{
        commandId: command.id,
        keys: parseShortcutDisplay(display)
      }];
    });
}

export function createShortcutRegistry(
  shortcuts: readonly CommandShortcut[],
  options: ShortcutRegistryOptions = {}
): ShortcutRegistry {
  const platform = options.platform ?? detectShortcutPlatform();
  const normalized = shortcuts
    .filter((shortcut) => shortcut.commandId.trim().length > 0 && shortcut.keys.length > 0)
    .filter((shortcut) => shortcut.platform === undefined || shortcut.platform === platform)
    .map((shortcut) => normalizeShortcut(shortcut, platform));
  const byChord = new Map<string, NormalizedShortcut[]>();

  // A chord is ambiguous only when DIFFERENT commands claim it. A command can reach this list twice
  // with the same chord (layout.group is both a layer action and a toolbar button); filing it twice
  // made `resolve` see two matches and return nothing, and `conflicts` report the command against
  // itself. The first entry is kept, so conflicts list commands in their original order.
  normalized.forEach((shortcut) => {
    const chord = shortcutChord(shortcut);
    const entries = byChord.get(chord) ?? [];
    if (!entries.some((entry) => entry.commandId === shortcut.commandId)) {
      byChord.set(chord, [...entries, shortcut]);
    }
  });

  return {
    list: () => [...normalized],
    conflicts: () => [...byChord.entries()]
      .filter(([, entries]) => entries.length > 1)
      .map(([chord, entries]) => ({
        chord,
        commandIds: entries.map((entry) => entry.commandId)
      })),
    resolve: (input) => {
      if (input.defaultPrevented || shouldIgnoreShortcutTarget(input.target ?? null, input.key)) {
        return undefined;
      }

      const chord = keyboardEventChord(input);
      const matches = byChord.get(chord) ?? [];
      return matches.length === 1 ? matches[0].commandId : undefined;
    }
  };
}

export function normalizeShortcut(
  shortcut: CommandShortcut,
  platform: ShortcutPlatform = detectShortcutPlatform()
): NormalizedShortcut {
  const modifiers = new Set<ShortcutModifier>();
  const keyTokens = shortcut.keys.map((key) => key.trim()).filter(Boolean);
  const keyToken = keyTokens.at(-1);
  if (!keyToken) {
    throw new Error(`Shortcut "${shortcut.commandId}" must include a key.`);
  }

  keyTokens.slice(0, -1).forEach((token) => {
    const modifier = normalizeModifier(token, platform);
    if (modifier) {
      modifiers.add(modifier);
    }
  });

  return {
    commandId: shortcut.commandId,
    key: normalizeKey(keyToken),
    modifiers: sortModifiers([...modifiers]),
    platform: shortcut.platform,
    when: shortcut.when
  };
}

export function keyboardEventChord(input: KeyboardEventLike): string {
  const modifiers: ShortcutModifier[] = [];
  if (input.ctrlKey) {
    modifiers.push("Ctrl");
  }
  if (input.altKey) {
    modifiers.push("Alt");
  }
  const key = normalizeKey(input.key);
  // Shift on the +/= key only chooses which legend the event reports, so counting it would make
  // Cmd+Shift+= — how most people press "Cmd plus" — a different chord from Cmd+=. No command
  // binds Shift together with this key, so folding it costs nothing and revives the press.
  if (input.shiftKey && key !== "=") {
    modifiers.push("Shift");
  }
  if (input.metaKey) {
    modifiers.push("Meta");
  }

  return chordFor(key, sortModifiers(modifiers));
}

export function shortcutChord(shortcut: NormalizedShortcut): string {
  return chordFor(shortcut.key, shortcut.modifiers);
}

/**
 * An open modal dialog. Every host dialog marks its root `aria-modal="true"` — the attribute that tells
 * assistive technology the rest of the window is inert — so the same attribute tells the keyboard.
 */
export const OPEN_MODAL_DIALOG_SELECTOR = '[aria-modal="true"]:not([hidden])';

/** True when `target` sits inside an open modal dialog, which owns every key typed there. */
export function isInsideModalDialog(target: EventTarget | null): boolean {
  if (!target || typeof Element === "undefined" || !(target instanceof Element)) {
    return false;
  }
  return target.closest(OPEN_MODAL_DIALOG_SELECTOR) !== null;
}

/**
 * True when a modal dialog is open anywhere in `root`. Focus inside a modal is not guaranteed — a
 * button that disables itself drops focus to `<body>` — so a canvas handler must ask this as well as
 * where the event landed, or a key pressed with focus on `<body>` reaches the document behind the modal.
 */
export function hasOpenModalDialog(root: ParentNode | undefined = globalThis.document): boolean {
  return root?.querySelector(OPEN_MODAL_DIALOG_SELECTOR) != null;
}

/**
 * The one check canvas keyboard AND clipboard handlers make before acting on the document: the event
 * came from inside a modal dialog, or one is open. The dialog's own handlers run regardless.
 */
export function isBlockedByModalDialog(
  target: EventTarget | null,
  root: ParentNode | undefined = globalThis.document
): boolean {
  return isInsideModalDialog(target) || hasOpenModalDialog(root);
}

export function shouldIgnoreShortcutTarget(target: EventTarget | null, key?: string): boolean {
  if (!target || typeof Element === "undefined" || !(target instanceof Element)) {
    return false;
  }

  // A modal dialog owns its keys. A focused button inside one is not an editable field, so without
  // this a modified shortcut (Cmd+Z, Cmd+V) pressed in a dialog acted on the document behind it.
  if (isInsideModalDialog(target)) {
    return true;
  }

  if (target instanceof HTMLElement && target.isContentEditable) {
    return true;
  }

  if (target.closest("input, textarea, select, [contenteditable='true']")) {
    return true;
  }

  // Space/Enter activate a focused button, so global bindings on those keys would double-fire.
  // Other shortcuts still work while a toolbar button has focus. Callers without a key keep
  // the older, conservative behavior until they can pass the actual event key.
  return Boolean(target.closest("button")) &&
    (key === undefined || key === " " || key === "Spacebar" || key === "Enter");
}

export function detectShortcutPlatform(): ShortcutPlatform {
  const platform = globalThis.navigator?.platform.toLowerCase() ?? "";
  if (platform.includes("mac")) {
    return "macos";
  }
  if (platform.includes("win")) {
    return "windows";
  }
  return "linux";
}

function normalizeModifier(token: string, platform: ShortcutPlatform): ShortcutModifier | undefined {
  const value = token.trim().toLowerCase();
  // Bindings are authored Mac-first ("Cmd+S"). Off macOS the Command key's role belongs to Ctrl —
  // mapping it to Meta would demand the Windows/Super key and leave every shortcut dead.
  if (value === "cmd" || value === "command" || value === "meta") {
    return platform === "macos" ? "Meta" : "Ctrl";
  }
  if (value === "ctrl" || value === "control") {
    return "Ctrl";
  }
  if (value === "cmdorctrl" || value === "mod") {
    return platform === "macos" ? "Meta" : "Ctrl";
  }
  if (value === "option" || value === "alt") {
    return "Alt";
  }
  if (value === "shift") {
    return "Shift";
  }
  return undefined;
}

function normalizeKey(key: string): string {
  // The spacebar reports key " ", so trimming first erased it: the event normalized to "" while a
  // "Space" binding normalized to " ", and the two could never match. Handle it before the trim.
  if (key === " ") {
    return " ";
  }
  const value = key.trim();
  const lower = value.toLowerCase();
  // "+" and "=" are the same physical key; which one a KeyboardEvent reports depends only on Shift
  // (and on the layout). Binding one and pressing the other must still match, so both normalize to
  // "=" — the unshifted legend, and what a US keyboard reports for the common Cmd+= press.
  if (value === "+" || value === "=") {
    return "=";
  }
  if (value === "-") {
    return "-";
  }
  if (lower === "plus") {
    return "=";
  }
  if (lower === "minus") {
    return "-";
  }
  if (lower === "space") {
    return " ";
  }
  if (lower === "esc") {
    return "escape";
  }
  if (value.length === 1) {
    return value.toLowerCase();
  }

  return lower;
}

function sortModifiers(modifiers: readonly ShortcutModifier[]): ShortcutModifier[] {
  return [...new Set(modifiers)].sort((left, right) => modifierOrder.indexOf(left) - modifierOrder.indexOf(right));
}

function chordFor(key: string, modifiers: readonly ShortcutModifier[]): string {
  return [...modifiers, key].join("+");
}
