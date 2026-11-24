import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Interactive3dWorkspaceStatus } from "./Interactive3dWorkspaceStatus";

describe("Interactive 3D Workspace status", () => {
  it("renders the relaxation hint alongside the status during a pull", () => {
    const rendered = renderToStaticMarkup(<Interactive3dWorkspaceStatus status="updateDrag" warnings={[]} />);
    expect(rendered).toContain("Drag an atom to change the shape. On release, it relaxes to a realistic shape, so atoms may move back.");
    expect(rendered).toContain("updateDrag");
  });
});
