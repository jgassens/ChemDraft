export type PluginPanelActionRequest = {
  sectionId: string;
  control: "prompt" | "select" | "button";
  controlId?: string;
  text?: string;
  selected?: string;
};

export type PluginPanelActionResult = { ok: true } | { ok: false; message: string };

export type PluginPanelActionHandler = (request: PluginPanelActionRequest) => Promise<PluginPanelActionResult>;
