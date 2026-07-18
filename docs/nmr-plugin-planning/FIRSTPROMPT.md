# First Prompt (moved)

This assignment was revised against the verified repository state
(commit `64cf513e`, 2026-07-07) and moved to:

**[prompts/01-runtime-bringup.md](prompts/01-runtime-bringup.md)**

Key revisions relative to the original version of this file:

- the desktop panel work is a **declarative report renderer** for the
  existing `PluginPanelReport` model, not a React panel-component registry;
- Analyze menu integration extends the existing `appMenu.ts` model and must
  handle the native-menu drift test (`nativePredefined` exclusion precedent);
- repository-state assumptions were verified and are listed with line-level
  evidence (see `STATUS.md` assumption ledger);
- naming conventions (`plugin.<name>.*` command IDs, `^0.1.0` apiVersion,
  build stamp) are now explicit constraints.

All future assignments live in [prompts/](prompts/), one bounded prompt per
milestone group, tracked in [STATUS.md](STATUS.md).
