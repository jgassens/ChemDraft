export interface AssistantCommandDescription {
  id: string;
  title: string;
  whenToUse: string;
  actsOn: "selection" | "document" | "view";
  changesChemistry: boolean;
  needsSelection: boolean;
}

// Deliberately enumerated: a new registry command is never automatically an assistant capability.
// Z-order commands are excluded: the current host scope gate requires every ID in a page-order
// patch to be selected, and native reorders may clear crossings with unselected bond owners.
export const ASSISTANT_COMMANDS = [
  ["layout.alignLeft", "Align Left", "Align the left edges of selected objects."],
  ["layout.alignRight", "Align Right", "Align the right edges of selected objects."],
  ["layout.alignTop", "Align Top", "Align the top edges of selected objects."],
  ["layout.alignBottom", "Align Bottom", "Align the bottom edges of selected objects."],
  ["layout.alignCenter", "Align Centers", "Align selected objects horizontally by their centres."],
  ["layout.alignMiddle", "Align Middles", "Align selected objects vertically by their centres."],
  ["layout.distributeHorizontal", "Distribute Horizontally", "Space three or more selected objects horizontally."],
  ["layout.distributeVertical", "Distribute Vertically", "Space three or more selected objects vertically."],
  ["layout.flipHorizontal", "Flip Horizontally", "Flip the selected drawing horizontally."],
  ["layout.flipVertical", "Flip Vertically", "Flip the selected drawing vertically."],
  ["layout.rotate90", "Rotate 90°", "Rotate the selected drawing by 90 degrees."],
  ["layout.group", "Group", "Keep selected objects together as a group."],
  ["layout.ungroup", "Ungroup", "Release the selected groups."],
  ["structure.cleanup2d", "Clean Up 2D", "Clean up the selected molecules' drawing geometry."],
  ["structure.cleanup3d", "Clean Up 3D", "Rebuild a clean 2D layout of the selected molecule using the geometry engine."],
  ["structure.spin3d", "Spin 3D", "Make it 3D: open the selected molecule for the user to rotate."],
  ["structure.openInteractive3d", "Interactive 3D", "Open the selected molecule for interactive 3D manipulation and minimization."]
].map(([id, title, whenToUse]) => ({ id: id!, title: title!, whenToUse: whenToUse!,
  actsOn: id === "structure.spin3d" || id === "structure.openInteractive3d" ? "view" : "selection",
  changesChemistry: false, needsSelection: true
})) satisfies AssistantCommandDescription[];

export function assistantCommand(id: string): AssistantCommandDescription | undefined {
  return ASSISTANT_COMMANDS.find(command => command.id === id);
}
