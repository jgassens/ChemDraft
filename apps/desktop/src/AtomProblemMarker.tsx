import { atomProblemCommandId, type AtomProblemTarget } from "./atomProblemCommands";
export function AtomProblemMarker({ target, x, y, explanation, invoke }: {
  target: AtomProblemTarget; x: number; y: number; explanation?: string; invoke(id: string): void;
}) {
  const commandId = atomProblemCommandId(target);
  return <g className="native-atom-invalid-marker" data-invalid-atom-id={target.atomId} data-command-id={commandId}
    role="button" tabIndex={0} aria-label={`Atom problem: ${explanation ?? "Check atom"}`} aria-haspopup="dialog"
    onPointerDown={event => { event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); }}
    onPointerUp={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); invoke(commandId); }}
    onKeyDown={event => { event.stopPropagation(); if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (!event.repeat) invoke(commandId); } }}>
    <title>{explanation}</title>
    <circle className="native-atom-invalid-ring" cx={x} cy={y} r="6" />
    <text className="native-atom-invalid-exclamation" x={x} y={y}>!</text>
  </g>;
}
