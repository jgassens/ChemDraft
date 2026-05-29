export type MechanismToolKind = "curved-arrow" | "half-headed-arrow" | "lone-pair" | "radical-dot";

export interface MechanismToolDefinition {
  id: string;
  kind: MechanismToolKind;
  commandId: string;
}
