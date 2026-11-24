export const INTERACTIVE_3D_WORKSPACE_HINT = "Drag an atom to change the shape. On release, it relaxes to a realistic shape, so atoms may move back.";

export function Interactive3dWorkspaceStatus({ status, energyLabel, warnings }: {
  status?: string;
  energyLabel?: string;
  warnings: string[];
}) {
  return <>{[
    INTERACTIVE_3D_WORKSPACE_HINT,
    status,
    energyLabel,
    ...new Set(warnings),
    "Esc to close"
  ].filter(Boolean).join(" · ")}</>;
}
