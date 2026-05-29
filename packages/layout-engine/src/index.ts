export type LayoutCommandId =
  | "layout.group"
  | "layout.ungroup"
  | "layout.align"
  | "layout.distribute"
  | "layout.rotate"
  | "layout.flip";

export interface LayoutOperationRequest {
  commandId: LayoutCommandId;
  objectIds: readonly string[];
}
