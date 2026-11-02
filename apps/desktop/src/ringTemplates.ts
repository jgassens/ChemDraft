import type { NativeMoleculeTemplateId } from "./documentWorkflow";

/** Shared mapping for every ring drawing tool, including placement and previews. */
export function nativeTemplateForToolCommand(commandId: string): NativeMoleculeTemplateId | undefined {
  switch (commandId) {
    case "tool.cyclopropane": return "cyclopropane";
    case "tool.cyclobutane": return "cyclobutane";
    case "tool.cyclopentane": return "cyclopentane";
    case "tool.cyclohexane": return "cyclohexane";
    case "tool.cycloheptane": return "cycloheptane";
    case "tool.cyclooctane": return "cyclooctane";
    case "tool.benzene": return "benzene";
    case "tool.chairCyclohexaneA": return "chairCyclohexaneA";
    case "tool.chairCyclohexaneB": return "chairCyclohexaneB";
    default: return undefined;
  }
}
