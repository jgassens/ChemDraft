import {
  PluginCommandInputSchema,
  type PluginCommandInput,
  type PluginPanelReport
} from "@chemdraft/plugin-api";

import type { PluginPanelActionRequest } from "./pluginPanelActionTypes";
import {
  ANALYSIS_WINDOW_OWNER_ID,
  MOLECULAR_INSPECTOR_WINDOW_ID,
  PATCH_REVIEW_WINDOW_ID,
  pluginPanelWindowLabel,
  type AnalysisWindowAction,
  type AnalysisWindowContent,
  type PluginPanelIdentity
} from "./panelBridge";

/** Resolve authority from retained host content, never from ids or content claimed by a panel. */
export function isAnalysisWindowActionAuthorized(
  action: AnalysisWindowAction,
  sourceLabel: string,
  owner: (PluginPanelIdentity & { content: AnalysisWindowContent }) | undefined
): boolean {
  if (!owner || sourceLabel !== pluginPanelWindowLabel(owner)) return false;
  const { content } = owner;
  const core = owner.pluginId === ANALYSIS_WINDOW_OWNER_ID;
  switch (action.kind) {
    case "close":
      return core && action.windowId === owner.panelId;
    case "copyMolecularInspector":
      // Chemical-name reports use the same text-copy bridge as the inspector.
      return content.kind === "report" || (core && content.kind === "molecularInspector");
    case "changeMolecularInterpretation":
      return core && owner.panelId === MOLECULAR_INSPECTOR_WINDOW_ID && content.kind === "molecularInspector";
    case "acceptPluginProposal":
    case "rejectPluginProposal":
      return core && owner.panelId === PATCH_REVIEW_WINDOW_ID && content.kind === "patchReview"
        && content.proposals.some((proposal) => proposal.id === action.proposalId);
    case "copySpectrum":
    case "saveBinaryFile":
    case "saveTextFile":
      return content.kind === "report" && content.report.sections.some((section) => section.kind === "linkedFigure");
  }
}

/** The panel id travels with the cross-window envelope, not with the untrusted control data. */
export type PluginPanelActionWithPanel = PluginPanelActionRequest & { panelId: string };

export type PluginPanelActionOwner =
  | ReadonlySet<string>
  | readonly string[]
  | ((commandId: string) => boolean)
  | { ownsCommand: (commandId: string) => boolean };

export type ResolvedPluginPanelAction =
  | { ok: true; commandId: string; input: PluginCommandInput }
  | { ok: false; reason: string };

/**
 * Rebuild an invocation from the live report. A panel is a separate webview and its event data is
 * untrusted: command ids, button payloads, option lists, and length limits must all come from the
 * report retained by the document window.
 */
export function resolvePluginPanelAction(
  report: PluginPanelReport,
  request: PluginPanelActionWithPanel,
  owner: PluginPanelActionOwner
): ResolvedPluginPanelAction {
  const section = report.sections.find((candidate) => "id" in candidate && candidate.id === request.sectionId);
  if (!section) return refused(`Unknown panel section "${request.sectionId}".`);

  let commandId: string;
  let rawInput: unknown;
  if (section.kind === "prompt") {
    if (request.control === "prompt") {
      if (section.disabled) return refused("This prompt is disabled.");
      if (typeof request.text !== "string") return refused("A prompt submission requires text.");
      if (request.text.length > section.maxLength) return refused(`Text exceeds the ${section.maxLength}-character limit.`);
      if (request.selected !== undefined
        && (!section.select || !section.select.options.some((option) => option.value === request.selected))) {
        return refused("The selected value is not an available option.");
      }
      commandId = section.commandId;
      rawInput = {
        source: "panel",
        panelId: request.panelId,
        sectionId: section.id,
        control: "prompt",
        text: request.text,
        ...(request.selected === undefined ? {} : { selected: request.selected })
      };
    } else if (request.control === "select") {
      if (!section.select) return refused("This section has no select control.");
      if (section.disabled) return refused("This prompt is disabled.");
      if (request.controlId !== undefined && request.controlId !== section.select.id) return refused("Unknown select control.");
      if (typeof request.selected !== "string" || !section.select.options.some((option) => option.value === request.selected)) {
        return refused("The selected value is not an available option.");
      }
      commandId = section.select.commandId ?? section.commandId;
      rawInput = {
        source: "panel",
        panelId: request.panelId,
        sectionId: section.id,
        control: "select",
        controlId: section.select.id,
        selected: request.selected
      };
    } else {
      return refused("This section does not contain an action button.");
    }
  } else if (section.kind === "actions") {
    if (request.control !== "button") return refused("This section only accepts action buttons.");
    const button = section.buttons.find((candidate) => candidate.id === request.controlId);
    if (!button) return refused("Unknown action button.");
    if (button.disabled) return refused("This action button is disabled.");
    commandId = button.commandId;
    rawInput = {
      source: "panel",
      panelId: request.panelId,
      sectionId: section.id,
      control: "button",
      controlId: button.id,
      ...(button.payload === undefined ? {} : { payload: button.payload })
    };
  } else {
    return refused("This panel section does not accept input.");
  }

  if (!ownsCommand(owner, commandId)) return refused("This command is not owned by the panel's plugin.");
  const parsed = PluginCommandInputSchema.safeParse(rawInput);
  if (!parsed.success) return refused("The panel action is invalid.");
  return { ok: true, commandId, input: parsed.data };
}

function ownsCommand(owner: PluginPanelActionOwner, commandId: string): boolean {
  if (typeof owner === "function") return owner(commandId);
  if ("ownsCommand" in owner) return owner.ownsCommand(commandId);
  return Array.isArray(owner) ? owner.includes(commandId) : (owner as ReadonlySet<string>).has(commandId);
}

function refused(reason: string): ResolvedPluginPanelAction {
  return { ok: false, reason };
}
