import {
  createShortcutRegistry,
  detectShortcutPlatform,
  normalizeShortcut,
  parseShortcutDisplay,
  shortcutChord,
  unshiftedShortcutKey,
  type KeyboardEventLike,
  type ShortcutPlatform
} from "./index";

export type ShortcutScope = "commands" | "atom" | "bond";
export type ShortcutOverrides = Partial<Record<ShortcutScope, Readonly<Record<string, readonly string[]>>>>;

export interface ShortcutAction {
  id: string;
  title: string;
  scope: ShortcutScope;
  defaults: readonly string[];
  lockedReason?: string;
}

export function actionShortcutKeys(action: ShortcutAction, overrides: ShortcutOverrides = {}): readonly string[] {
  return overrides[action.scope]?.[action.id] ?? action.defaults;
}

/**
 * Use the physical letter for hover actions, with Shift as the only case selector: the same
 * physical key fires the same hover letter regardless of layout or Caps Lock (Dvorak "." on KeyE
 * is still "e", AZERTY "," on KeyM is still "m"). The one exception is the two charge keys: when
 * the event's key is exactly "+" or "-" it is returned as typed. macOS reports Unicode-typed text
 * (an injected "+") with the placeholder code KeyA, which must not turn "+" into "a". No real
 * layout puts "+" or "-" on a letter-position key (Dvorak, Colemak, AZERTY, QWERTZ, Nordic, Swiss
 * and JIS all keep them on Equal, Minus, BracketRight, Slash, Digit or numpad codes), so this
 * changes nothing for physical keyboards. All other punctuation on a letter code keeps the
 * KeyA-KeyZ mapping.
 */
export function hoverKeyFromEvent(event: Pick<KeyboardEventLike, "key" | "code" | "shiftKey">): string {
  if (event.key === "+" || event.key === "-") return event.key;
  const letter = /^Key([A-Z])$/.exec(event.code ?? "")?.[1];
  return letter ? (event.shiftKey ? letter : letter.toLowerCase()) : event.key;
}

/**
 * The hover key a Shift+= press stands for when the event reports the unshifted legend. Some macOS
 * input paths (and automation) deliver Shift+= as key "=" with Shift held; the global chord engine
 * folds +/= and drops Shift, but hover tables keep literal characters, so that press means "+".
 * Only the physical Equal key (code "Equal") or code "NumpadEqual" with Shift alone qualifies, as an
 * allow-list. NumpadEqual is how automation tools inject Shift+=; it also means a physical keypad
 * Shift+= (key "=", code NumpadEqual) charges like "+", a deliberate, documented alias, since the
 * code cannot tell automation from a real keypad. Everything else is untouched: bare "=", numpad +,
 * layouts that report "+" directly, layouts where Shift+0 types "=" (German, Nordic: code Digit0),
 * and Cmd/Ctrl+= zoom.
 *
 * Known limitation: a layout whose Shift+Equal genuinely types "=" (for example macOS Sindhi or
 * Cherokee-QWERTY) is treated as "+" for hover actions. Literal "=" bindings still win because the
 * literal key is tried first.
 */
export function shiftedHoverKeyAlternate(
  event: Pick<KeyboardEventLike, "key" | "code" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey">
): string | undefined {
  return event.key === "=" && (event.code === "Equal" || event.code === "NumpadEqual") && event.shiftKey &&
    !event.ctrlKey && !event.altKey && !event.metaKey ? "+" : undefined;
}

/**
 * Resolve a hover key against a hover lookup: the literal key first, then (only if that misses) the
 * shifted alternate. Remapped or cleared bindings are respected because both go through `lookup`.
 */
export function resolveHoverKey<T>(
  event: Pick<KeyboardEventLike, "key" | "code" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey">,
  lookup: (key: string) => T | undefined
): { key: string; match: T | undefined } {
  const key = hoverKeyFromEvent(event);
  const match = lookup(key);
  if (match !== undefined) return { key, match };
  const alternate = shiftedHoverKeyAlternate(event);
  const alternateMatch = alternate === undefined ? undefined : lookup(alternate);
  return alternate !== undefined && alternateMatch !== undefined ? { key: alternate, match: alternateMatch } : { key, match };
}

/** The character a hover-shortcut recorder stores for a press: Shift+= is recorded as "+". */
export function recordedHoverKeyFromEvent(
  event: Pick<KeyboardEventLike, "key" | "code" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey">
): string {
  return shiftedHoverKeyAlternate(event) ?? hoverKeyFromEvent(event);
}

/** Apply overrides to a hover scope while retaining literal case and punctuation. */
export function createHoverShortcutRegistry(
  defaults: Readonly<Record<string, string>>,
  overrides?: Readonly<Record<string, readonly string[]>>
): ReadonlyMap<string, string> {
  const known = new Set(Object.values(defaults));
  const entries = Object.entries(defaults).filter(([, id]) => !Object.hasOwn(overrides ?? {}, id));
  for (const [id, keys] of Object.entries(overrides ?? {})) {
    if (known.has(id)) entries.push(...keys.map(key => [key, id] as [string, string]));
  }
  const registry = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [key, id] of entries) {
    if (registry.has(key) && registry.get(key) !== id) ambiguous.add(key);
    registry.set(key, id);
  }
  for (const key of ambiguous) registry.delete(key);
  return registry;
}

function keysForScope(key: string, scope: ShortcutScope): string[] {
  if (scope === "commands") return parseShortcutDisplay(key);
  return /^[A-Z]$/.test(key) || unshiftedShortcutKey(key) ? ["Shift", key] : [key === " " ? "Space" : key];
}

export function reservedShortcutReason(
  keys: readonly string[],
  platform: ShortcutPlatform = detectShortcutPlatform()
): string | undefined {
  if (!keys.length) return "Press a single key or key combination.";
  const { key, modifiers } = normalizeShortcut({ commandId: "candidate", keys }, platform);
  const has = (modifier: typeof modifiers[number]) => modifiers.includes(modifier);
  const main = has(platform === "macos" ? "Meta" : "Ctrl");
  if (key === "f5" || key === "browserrefresh" ||
      (key === "r" && (main || has("Ctrl")) && !has("Alt"))) {
    return "Reserved to prevent the webview from reloading.";
  }
  if (main && (key === "q" || key === "w")) return "Reserved for Quit and Close Window.";
  if (key === "escape" || (key === "tab" && modifiers.every(modifier => modifier === "Shift"))) {
    return "Reserved for canceling or moving keyboard focus.";
  }
  const macReserved = (main && !has("Ctrl") && (
    (["tab", "`"].includes(key) && !has("Alt")) ||
    (!has("Shift") && (key === " " || key === "h" || (key === "m" && !has("Alt")))) ||
    (has("Shift") && ["3", "4", "5", "6"].includes(key))
  )) || (main && has("Ctrl") && !has("Alt") && !has("Shift") && key === "f") ||
    (has("Ctrl") && ["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(key));
  const otherReserved = has("Meta") || (has("Alt") && ["f4", "tab", "escape", " "].includes(key)) ||
    (has("Ctrl") && (key === "escape" || (has("Alt") && key === "delete")));
  if (["capslock", "numlock", "scrolllock", "printscreen", "contextmenu"].includes(key) ||
      (platform === "macos" ? macReserved : otherReserved)) return "Reserved by the operating system.";
  return undefined;
}

export type ShortcutEdit = { kind: "assign"; key: string } | { kind: "clear" } | { kind: "reset" };

export type ShortcutEditResult =
  | { kind: "updated"; overrides: ShortcutOverrides }
  | { kind: "conflict"; actions: readonly ShortcutAction[] }
  | { kind: "refused"; reason: string };

/** Atom and bond are mutually exclusive. A command can be shadowed by either hover scope. */
export function editShortcut(
  actions: readonly ShortcutAction[],
  overrides: ShortcutOverrides,
  action: ShortcutAction,
  edit: ShortcutEdit,
  platform: ShortcutPlatform = detectShortcutPlatform(),
  replace = false
): ShortcutEditResult {
  if (action.lockedReason) return { kind: "refused", reason: action.lockedReason };
  const keys = edit.kind === "reset" ? action.defaults : edit.kind === "assign" ? [edit.key] : [];
  if (edit.kind === "assign") {
    const reason = reservedShortcutReason(keysForScope(edit.key, action.scope), platform);
    if (reason) return { kind: "refused", reason };
  }
  const rows = actions.filter(other => (other.id !== action.id || other.scope !== action.scope) &&
    (other.scope === action.scope || other.scope === "commands" || action.scope === "commands") &&
    // Defaults can overlap by design. Reset only collides with an explicit customization.
    (edit.kind !== "reset" || Object.hasOwn(overrides[other.scope] ?? {}, other.id)));
  const bindings = (row: ShortcutAction, rowKeys: readonly string[], commandId: string) => rowKeys.map(key => ({
    commandId, keys: keysForScope(key, row.scope)
  }));
  const candidateId = "candidate";
  const conflicts = createShortcutRegistry([
    ...bindings(action, keys, candidateId),
    ...rows.flatMap((row, index) => bindings(row, actionShortcutKeys(row, overrides), String(index)))
  ], { platform }).conflicts().filter(conflict => conflict.commandIds.includes(candidateId));
  const conflictingRows = rows.filter((_, index) => conflicts.some(conflict => conflict.commandIds.includes(String(index))));
  const locked = conflictingRows.find(row => row.lockedReason);
  if (locked?.lockedReason) return { kind: "refused", reason: locked.lockedReason };
  if (conflictingRows.length && !replace) return { kind: "conflict", actions: conflictingRows };

  const next = { ...overrides };
  for (const row of conflictingRows) {
    const remaining = actionShortcutKeys(row, overrides).filter(key => {
      const chord = shortcutChord(normalizeShortcut({ commandId: row.id, keys: keysForScope(key, row.scope) }, platform));
      return !conflicts.some(conflict => conflict.chord === chord);
    });
    next[row.scope] = { ...next[row.scope], [row.id]: remaining };
  }
  const scope = { ...next[action.scope] };
  if (edit.kind === "reset" || (keys.length === action.defaults.length && keys.every((key, i) => key === action.defaults[i]))) {
    delete scope[action.id];
  } else {
    scope[action.id] = keys;
  }
  next[action.scope] = scope;
  return { kind: "updated", overrides: next };
}
