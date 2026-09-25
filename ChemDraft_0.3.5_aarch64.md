Fixes for atom-label typing and for Undo/Redo in the Edit menu, both reported by testers.

- **Typing a substituent no longer erases it.** If the label box lost focus while you were typing (for example, when a palette window briefly took focus), your remaining keystrokes could act as tool shortcuts: `e` armed the eraser, element letters replaced the label with a single atom, and Backspace stripped it. The label box now keeps focus, Tab finishes the label like Return, and the edited atom is no longer left selected when editing ends.
- **Edit ▸ Undo and Edit ▸ Redo now undo your drawing.** The menu items (⌘Z and ⇧⌘Z) previously reached only text-field undo. They now undo and redo drawing changes. In a text field, including text fields in palette windows, they still undo your typing.

Automatic updates are delivered via Sparkle (File ▸ Check for Updates…).
