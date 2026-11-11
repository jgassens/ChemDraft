export const VIBE_CODE_GUIDE = {
  title: "Vibe Code Your Own Plugin",
  steps: [
    "Save the starter file into a new, empty folder.",
    "Open your coding agent (Codex, Claude Code or similar) in that folder and ask it to read the starter file (or drag the file into its chat).",
    "Describe what your plugin should do.",
    "Let the agent build and package it (it follows the file's steps).",
    "Install it: Plugins ▸ Add or Remove Plugins… ▸ Add plugin from package…"
  ],
  safety: "A plugin you build runs on your computer with the permissions it declares, so only install plugins that you or your agent wrote and that you trust."
} as const;
