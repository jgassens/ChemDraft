export type EditorShellRegion = "toolbar" | "canvas" | "inspector" | "status";

export interface EditorShellPanel {
  id: string;
  title: string;
  region: EditorShellRegion;
}
