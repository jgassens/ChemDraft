/**
 * Data a detached panel is permitted to send to its owning document window. The document
 * window resolves all command metadata against its current report; this message is not trusted
 * to carry a command id, payload, or control limits.
 */
export type PluginPanelActionRequest = {
  sectionId: string;
  control: "prompt" | "select" | "button";
  controlId?: string;
  text?: string;
  selected?: string;
};

export type PluginPanelActionResult = { ok: true } | { ok: false; message: string };

export type PluginPanelActionHandler = (request: PluginPanelActionRequest) => Promise<PluginPanelActionResult>;
