export const VIBE_CODE_GUIDE = {
  title: "Vibe Code Your Own Plugin",
  steps: [
    "Save the starter file.",
    "Open your coding agent (Codex, Claude Code or similar) in an empty folder and give it the file.",
    "Describe what your plugin should do.",
    "Let the agent build and package it (it follows the file's steps).",
    "Install it: Plugins ▸ Add or Remove Plugins… ▸ Add plugin from package…"
  ],
  safety: "A plugin you build runs on your computer with the permissions it declares, so only install plugins that you or your agent wrote and that you trust."
} as const;
