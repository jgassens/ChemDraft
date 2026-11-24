export const INTERACTIVE_3D_WORKSPACE_HINT = "Drag an atom to change the shape. On release, it relaxes to a realistic shape, so atoms may move back.";

type Interactive3dWorkspaceStatusProps = {
  status?: string;
  energyLabel?: string;
  warnings: string[];
};

export function interactive3dWorkspaceStatusText({ status, energyLabel, warnings }: Interactive3dWorkspaceStatusProps): string {
  return [
    status,
    energyLabel,
    ...new Set(warnings),
    INTERACTIVE_3D_WORKSPACE_HINT,
    "Esc to close"
  ].filter(Boolean).join(" · ");
}

export function Interactive3dWorkspaceStatus(props: Interactive3dWorkspaceStatusProps) {
  return <>{interactive3dWorkspaceStatusText(props)}</>;
}
