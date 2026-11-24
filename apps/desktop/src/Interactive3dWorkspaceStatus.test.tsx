import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { INTERACTIVE_3D_WORKSPACE_HINT, interactive3dWorkspaceStatusText, Interactive3dWorkspaceStatus } from "./Interactive3dWorkspaceStatus";

describe("Interactive 3D Workspace status", () => {
  it("puts status, energy and refinement warnings before the hint in the line and tooltip", () => {
    const props = { status: "Ready", energyLabel: "Energy: 12", warnings: ["Could not refine the 3D starting shape.", "Could not refine the 3D starting shape."] };
    const text = `Ready · Energy: 12 · Could not refine the 3D starting shape. · ${INTERACTIVE_3D_WORKSPACE_HINT} · Esc to close`;
    expect(interactive3dWorkspaceStatusText(props)).toBe(text);
    const rendered = renderToStaticMarkup(<span title={interactive3dWorkspaceStatusText(props)}><Interactive3dWorkspaceStatus {...props} /></span>);
    expect(rendered).toBe(`<span title="${text}">${text}</span>`);
  });

  it("puts an error status before the hint", () => {
    const rendered = renderToStaticMarkup(<Interactive3dWorkspaceStatus status="Could not update the shape." warnings={[]} />);
    expect(rendered).toBe(`Could not update the shape. · ${INTERACTIVE_3D_WORKSPACE_HINT} · Esc to close`);
  });
});
