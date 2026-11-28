import { atomProblemBadgeRadiusPx } from "@chemdraft/layout-engine";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { atomProblemCommandId, type AtomProblemTarget } from "./atomProblemCommands";
import { detectDesktopShortcutPlatform } from "./keyboardShortcuts";
export function AtomProblemMarker({ target, x, y, explanation, invoke, platform = detectDesktopShortcutPlatform() }: {
  target: AtomProblemTarget; x: number; y: number; explanation?: string; invoke(id: string): void; platform?: ShortcutPlatform;
}) {
  const commandId = atomProblemCommandId(target);
  return <g className="native-atom-invalid-marker" data-invalid-atom-id={target.atomId} data-command-id={commandId}
    role="button" tabIndex={0} aria-label={`Atom problem: ${explanation ?? "Check atom"}`} aria-haspopup="dialog"
    onPointerDown={event => { event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); }}
    onPointerUp={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); invoke(commandId); }}
    onKeyDown={event => {
      const modifier = platform === "macos" ? event.metaKey : event.ctrlKey;
      const key = event.key.toLowerCase();
      const noExtraModifier = !(platform === "macos" ? event.ctrlKey : event.metaKey) && !event.altKey;
      const undoRedo = modifier && noExtraModifier && (key === "z" || (platform !== "macos" && key === "y" && !event.shiftKey));
      if (!undoRedo) event.stopPropagation();
      // The window reload guard handles Ctrl+R and F5. Consume Windows-key R on the badge too.
      if (platform === "windows" && event.metaKey && key === "r") event.preventDefault();
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (!event.repeat) invoke(commandId); }
    }}>
    <title>{explanation}</title>
    <circle className="native-atom-invalid-ring" cx={x} cy={y} r={atomProblemBadgeRadiusPx} />
    <text className="native-atom-invalid-exclamation" x={x} y={y}>!</text>
  </g>;
}
