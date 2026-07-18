# ADR-0011: No command arguments; value-encoded command IDs

- **Status:** accepted
- **Date:** 2026-07-07
- **Source:** gap considered building M1–M3 (reports/0001)

## Context

`PluginHost.invokeCommand(commandId)` takes no payload, and menu items carry
only a `commandId`. The NMR ¹H-vs-¹³C choice therefore cannot be "one command
with a nucleus argument." The tempting fix is to add an args channel to command
invocation.

The ChemDraft repo already has an explicit, load-bearing convention against
this: commands use **value-encoded IDs** and factory helpers, and its main-repo
AGENTS.md says "Do not introduce generic `*.set` commands with hidden value
parameters." Menu and toolset contributions dispatch by id alone, so an args
channel would not even reach them.

## Decision

Do not add arguments to command invocation. Express variants as distinct,
value-encoded commands:

- ¹³C prediction: `plugin.nmrPredictor.predictSelectedStructure`
- experimental ¹H: `plugin.nmrPredictor.predictWithProtonExperimental`

Each gets its own menu item. If a future panel needs many parameterized
actions, the extension point is a declarative `actions` section kind whose
items each reference a contributed command id (validated like toolset items) —
still no free-form args.

## Consequences

Consistent with the repo's command model; menu/toolset dispatch stays uniform;
permissions and provenance stay attached to concrete command ids. Cost: a
combinatorial explosion of commands if parameters multiply — that pressure is
the signal to design the `actions` section kind (M9+), not to add an args
channel. Revisit only if that explosion actually materializes.
