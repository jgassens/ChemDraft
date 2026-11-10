# Assistant tools and plugin sessions

ChemDraft owns the tool registry, request lifetime, permissions, document history, and local MCP
transport. Plugins own their tool implementations. No provider prompts or chemistry policy live in
this infrastructure.

## Session-local tools (API 0.1.21)

`PluginAssistantAPI.createToolSession(PluginAssistantToolSessionRequest)` accepts optional
`extraTools: PluginAssistantToolDescriptor[]`. The controller validates the complete request before
opening the native session: at most eight tools, names matching `/^[a-z][a-z0-9_]{0,47}$/`, no duplicate
or host-name collisions, descriptions at most 1,000 characters, JSON Schema objects at most 16 KiB
of UTF-8 JSON. It snapshots definitions before asynchronous session creation. Session ownership binds
the plugin id and request id; extra descriptors never enter the shared host registry.

MCP `tools/list` combines the host list with the current session's extras. `tools/call` first resolves
that session and its owner. Host names still use `callAssistantTool`. An extra name uses
`PluginHost.invokeAssistantTool`, which rechecks the assistant permissions and creates an ordinary
scoped capability invocation with the request's captured selection and inserted objects.
Successful direct-patch receipts update the request's touched/inserted scope, so later host tools
can operate on those insertions. Direct writes join the existing assistant history transaction.
The embedding write request carries an abort signal; the document window rechecks it after any
gesture wait, preventing a cancelled tool's queued write from committing.

The plugin registers `onAssistantToolCall(context, { sessionId, name, input }, signal)` beside
`commandHandlers` in its worker registration. `createWorkerRoutedOptions` delegates to
`PluginWorkerBridge.invokeAssistantTool`. The additive host-to-worker message
`invokeAssistantTool` shares command correlation ids, capability requests, settlements, and abort
messages. The callback executes only in the owning worker. The worker builds the same declared-only
capability facade it builds for commands, while the host rechecks each capability call. Input
validation specific to the contributed tool is the plugin handler's responsibility.
Desktop tool invocations also share command lifetime tracking for naming and depiction cancellation.

The controller shares a four-call limit between host and extra tools. Extra calls have the default
120-second deadline and an 8 MiB UTF-8 JSON result ceiling, matching the native MCP result budget.
Returned data must satisfy `PluginAssistantToolResultSchema`. Handler failures, invalid/oversized
results, and deadlines become `{ isError: true, content: [{ type: "text", text }] }`.
Session close, request end, tab close, and plugin unregister abort pending calls and invalidate their
host invocation; the worker receives abort and suppresses late settlements. An unregistered plugin
or a closed session cannot invoke a handler. A plugin's ordinary `listTools`/`callTool` facade
continues to serve the host tools only.

## Native transport

The existing Rust `assistant_mcp` server binds to loopback only and retains credentials. Its
authenticated session routes `tools/list`, `tools/call`, and cancellation messages to the owning
TypeScript controller. Requests are capped at 1 MiB, results at 8 MiB, with at most four pending
calls per session. Native tool-call deadline expiry returns an MCP tool error result too, so a
race with the TypeScript timer cannot turn it into a transport error. Extra tools require no network capability and no new dangerous permission.

## Chemistry properties

`chemistry.properties` is gated by `chemistry.compute`. It requests `rdkit.composition`,
`rdkit.average-mass`, and `rdkit.monoisotopic-mass` from the same lazy analysis client the property
panel uses. Unique transient analysis slots prevent concurrent plugin calls from superseding each
other. Only successful source-interpretation results are projected into the public response:
whole drawn composition, charge, isotope-label flag, RDKit version, and the original result
conventions (including g/mol and Da). No alternate parsing, desalting, or mass calculation occurs.
