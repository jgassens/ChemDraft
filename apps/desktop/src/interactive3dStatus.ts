import type { Engine3dWorkspaceSessionState } from "./engine3dSidecar";

/**
 * What the status line says while Interactive 3D is open. It used to show the workspace's internal
 * phase names ("attaching", "tug-ready") and per-frame traces ("beginDrag · a3", "updateDrag · a3 →
 * x, y, z", "3 atoms · coord rev 4 · settle"), and that text hid the one line that explained the
 * gestures. The line now always reads as an instruction or a plain progress note; the traces go to
 * the opt-in CHEMDRAFT_ENGINE3D_LOG diagnostic instead (`logEngine3dDiagnostic`).
 */
export type Interactive3dPhase = "attaching" | "ready" | "pulling" | "settling";

const INTERACTIVE_3D_PHASE_LABELS: Readonly<Record<Interactive3dPhase, string>> = {
  attaching: "Starting Interactive 3D…",
  ready: "Drag empty space to rotate · click outside to flatten",
  pulling: "Pulling the atom · release to let the structure settle",
  settling: "Settling the structure…"
};

export function interactive3dPhaseLabel(phase: Interactive3dPhase): string {
  return INTERACTIVE_3D_PHASE_LABELS[phase];
}

/**
 * After the sidecar answered: its latest error if it reported one, otherwise the label of the phase
 * the workspace is in — "ready" (the instructions) unless a pull is still going on or settling.
 */
export function interactive3dSessionStatus(
  session: Engine3dWorkspaceSessionState,
  phase: Interactive3dPhase = "ready"
): string {
  return session.errors.at(-1) ?? INTERACTIVE_3D_PHASE_LABELS[phase];
}

/**
 * What the status line says when Esc (or Undo) closes the 3D view without flattening. Interactive 3D
 * rides the Spin 3D overlay, and the Linux 1.2.2 retest found Esc in Interactive 3D reporting "Spin
 * canceled", a command the user never chose. Each view now names itself.
 */
export function spin3dViewCanceledStatus(interactive3d: boolean): string {
  return interactive3d ? "Interactive 3D canceled" : "Spin canceled";
}
