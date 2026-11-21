import { useHotkeyRecorder } from "@tanstack/react-hotkeys";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  actionShortcutKeys, editShortcut, type ShortcutAction, type ShortcutEdit,
  type ShortcutOverrides, type ShortcutPlatform
} from "@chemdraft/shortcut-engine";
import { capturedShortcut, keyboardShortcutActions } from "./customKeyboardShortcuts";
import type { KeybindingScheme } from "./keybindingSettings";
import { detectDesktopShortcutPlatform } from "./keyboardShortcuts";
import { formatShortcutLabel } from "./toolsets";
import { isDesktopRuntime } from "./window-manager";

async function suspendNativeMenuShortcuts(recording: boolean, platform: ShortcutPlatform) {
  if (platform !== "macos" || !isDesktopRuntime()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_keybinding_scheme", { recording });
}

const scopeLabels = { commands: "Command", atom: "Over an atom", bond: "Over a bond" };

export function KeyboardPreferences({
  scheme, overrides, onUpdate, platform = detectDesktopShortcutPlatform()
}: {
  scheme: KeybindingScheme;
  overrides?: ShortcutOverrides;
  onUpdate: (overrides: ShortcutOverrides) => Promise<void>;
  platform?: ShortcutPlatform;
}) {
  const search = useRef<HTMLInputElement>(null);
  const current = useRef<ShortcutAction | undefined>(undefined);
  const recordingTicket = useRef(0);
  const deletionKey = useRef<KeyboardEvent | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<ShortcutAction>();
  const [conflict, setConflict] = useState<{ action: ShortcutAction; edit: ShortcutEdit; actions: readonly ShortcutAction[] }>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const actions = useMemo(() => keyboardShortcutActions(scheme, platform), [scheme, platform]);
  const reportError = (error: unknown) => setMessage(error instanceof Error ? error.message : String(error));
  const commit = (next: ShortcutOverrides) => {
    setConflict(undefined);
    setBusy(true);
    void onUpdate(next).catch(reportError).finally(() => setBusy(false));
  };
  const apply = (action: ShortcutAction, edit: ShortcutEdit, replace = false) => {
    setMessage("");
    const result = editShortcut(actions, overrides ?? {}, action, edit, platform, replace);
    if (result.kind === "conflict") setConflict({ action, edit, actions: result.actions });
    if (result.kind === "refused") setMessage(result.reason);
    if (result.kind === "updated") commit(result.overrides);
  };
  const finishRecording = () => {
    recordingTicket.current += 1;
    current.current = undefined;
    setRecording(undefined);
    void suspendNativeMenuShortcuts(false, platform).catch(reportError);
  };
  const recorder = useHotkeyRecorder({
    platform: platform === "macos" ? "mac" : platform,
    validate: (hotkey, { event }) => {
      const candidate = capturedShortcut(hotkey, event, current.current?.scope ?? "commands", platform);
      return "key" in candidate ? true : candidate.reason;
    },
    onReject: rejection => setMessage(rejection.message ?? "This key combination is unavailable."),
    onCancel: finishRecording,
    onClear: () => {
      const action = current.current;
      const event = deletionKey.current;
      finishRecording();
      if (!action || !event) return;
      const candidate = capturedShortcut(event.key, event, action.scope, platform);
      if ("key" in candidate) apply(action, { kind: "assign", key: candidate.key });
      else setMessage(candidate.reason);
    },
    onRecord: (hotkey, { event }) => {
      const action = current.current;
      finishRecording();
      if (!action) return;
      const candidate = capturedShortcut(hotkey, event, action.scope, platform);
      if ("key" in candidate) apply(action, { kind: "assign", key: candidate.key });
    }
  });

  useEffect(() => {
    const end = () => {
      if (current.current) recorder.cancelRecording();
    };
    // The recorder reports unmodified Delete and Backspace through onClear. Capture their
    // metadata for that callback so they can be assigned like other keys using the same flow.
    const rememberDeletionKey = (event: KeyboardEvent) => {
      deletionKey.current = current.current && (event.key === "Delete" || event.key === "Backspace") ? event : undefined;
    };
    window.addEventListener("keydown", rememberDeletionKey, true);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("keydown", rememberDeletionKey, true);
      window.removeEventListener("blur", end);
      if (current.current) {
        current.current = undefined;
        recordingTicket.current += 1;
        void suspendNativeMenuShortcuts(false, platform).catch(error => console.error("Could not restore menu shortcuts", error));
      }
    };
  }, [platform, recorder.cancelRecording, scheme]);

  useEffect(() => {
    const showKeyboard = () => {
      if (window.location.hash !== "#keyboard") return;
      search.current?.focus();
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    };
    showKeyboard();
    window.addEventListener("hashchange", showKeyboard);
    return () => window.removeEventListener("hashchange", showKeyboard);
  }, []);

  async function start(action: ShortcutAction) {
    if (current.current === action) {
      recorder.cancelRecording();
      return;
    }
    const ticket = ++recordingTicket.current;
    current.current = action;
    setMessage("");
    setRecording(action);
    try {
      await suspendNativeMenuShortcuts(true, platform);
      if (recordingTicket.current === ticket) recorder.startRecording();
    } catch (error) {
      if (recordingTicket.current !== ticket) return;
      finishRecording();
      reportError(error);
    }
  }

  const visible = actions.flatMap(action => {
    const keys = actionShortcutKeys(action, overrides);
    const labels = keys.map(key => action.scope === "commands" ? formatShortcutLabel(key, platform) ?? key : key === " " ? "Space" : key);
    const terms = [action.title, scopeLabels[action.scope], ...keys, ...labels].join(" ").toLowerCase();
    return terms.includes(query.trim().toLowerCase()) ? [{ action, labels }] : [];
  });
  const editing = busy || conflict !== undefined;

  return (
    <section className="preferences-shortcuts" aria-label="Keyboard shortcut assignments">
      <div className="preferences-shortcut-controls">
        <input ref={search} type="search" aria-label="Search shortcuts" placeholder="Search shortcuts" value={query}
          onFocus={() => { if (current.current) recorder.cancelRecording(); }}
          onChange={event => setQuery(event.currentTarget.value)} />
        <button type="button" disabled={editing || Boolean(recording)} onClick={() => { setMessage(""); commit({}); }}>
          Reset all to scheme defaults
        </button>
      </div>
      <p className="preferences-section-hint">Click a shortcut and press a new key, or press Escape to cancel. Hold Shift for uppercase hover letters.</p>
      <div className="preferences-shortcut-feedback" aria-live="polite">
        {message && <p>{message}</p>}
        {conflict && <div role="group" aria-label="Shortcut conflict">
          <p>That shortcut is used by {conflict.actions.map(action => action.title).join(", ")}.</p>
          <button type="button" onClick={() => apply(conflict.action, conflict.edit, true)}>Replace</button>
          <button type="button" onClick={() => setConflict(undefined)}>Cancel</button>
        </div>}
      </div>
      <ul className="preferences-shortcut-list">
        {visible.map(({ action, labels }) => {
          const custom = Object.hasOwn(overrides?.[action.scope] ?? {}, action.id);
          const active = recording?.id === action.id && recording.scope === action.scope;
          const available = !editing && (!recording || active) && !action.lockedReason;
          return <li key={action.scope + action.id}>
            <span><strong>{action.title}</strong><small>{action.lockedReason ?? scopeLabels[action.scope]}</small></span>
            <button type="button" disabled={!available} aria-label={active
              ? "Cancel recording for " + action.title
              : "Change shortcut for " + action.title + " (" + scopeLabels[action.scope] + ")"}
              onClick={() => { void start(action); }}>
              {active ? "Press a key…" : labels.join(" / ") || "Unassigned"}
            </button>
            <button type="button" disabled={!available || active || !labels.length} aria-label={"Clear " + action.title}
              onClick={() => apply(action, { kind: "clear" })}>Clear</button>
            <button type="button" disabled={!available || active || !custom} aria-label={"Reset " + action.title}
              onClick={() => apply(action, { kind: "reset" })}>Reset</button>
          </li>;
        })}
      </ul>
      {visible.length === 0 && <p role="status">No matching shortcuts.</p>}
    </section>
  );
}
