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

  normalized.forEach((shortcut) => {
    const chord = shortcutChord(shortcut);
    byChord.set(chord, [...(byChord.get(chord) ?? []), shortcut]);
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
      if (input.defaultPrevented || shouldIgnoreShortcutTarget(input.target ?? null)) {
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
  if (input.shiftKey) {
    modifiers.push("Shift");
  }
  if (input.metaKey) {
    modifiers.push("Meta");
  }

  return chordFor(normalizeKey(input.key), sortModifiers(modifiers));
}

export function shortcutChord(shortcut: NormalizedShortcut): string {
  return chordFor(shortcut.key, shortcut.modifiers);
}

export function shouldIgnoreShortcutTarget(target: EventTarget | null): boolean {
  if (!target || typeof Element === "undefined" || !(target instanceof Element)) {
    return false;
  }

  if (target instanceof HTMLElement && target.isContentEditable) {
    return true;
  }

  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
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
  if (value === "cmd" || value === "command" || value === "meta") {
    return "Meta";
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
  const value = key.trim();
  const lower = value.toLowerCase();
  if (value === "+") {
    return "+";
  }
  if (value === "-") {
    return "-";
  }
  if (lower === "plus") {
    return "+";
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
