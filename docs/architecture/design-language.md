# Design Language

ChemDraft's first-pass design language is:

> Restrained technical minimalism: Metro-like canvas minimalism with Material-like interaction clarity.

The document canvas should stay visually dominant: flat, quiet, typographic, low-chrome, and content-first. Surrounding controls should use consistent spacing, predictable component states, and clear hover, active, focus, selected, and disabled feedback.

For the current desktop shell, `apps/desktop/src/App.css` is the canonical design-token layer. CSS variables should define app, canvas, panel, page, text, border, spacing, radius, control-size, and state tokens. Do not create a parallel `ui-kit` token system unless another package has a real consumer and the canonical layer is documented.

Use `#1d7f68` as the restrained accent, with derived shades for readable active, selected, hover, and focus states. Red remains semantic for invalid, delete, and warning states. Style only ChemDraft-owned chrome around the Ketcher host; do not patch vendored Ketcher internals or change Ketcher behavior.

Avoid decorative animation, large rounded controls, playful palettes, dashboard chrome, and one-off component fixes where a shared token or state class is appropriate.
