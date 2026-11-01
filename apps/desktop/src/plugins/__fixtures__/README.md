# Host integration test plugins

These are original, test-only plugins covered by the repository's Apache-2.0
licence. They contain no external plugin code or recorded service output.
The package provenance fields are synthetic metadata required by the package loader;
`licenseFile` points to the repository licence rather than a bundled licence copy.

- `overlay-chat` exercises setup sections, action routing, prompt submission,
  transcript updates, status messages, and clearing a conversation without a panel.
- `overlay-transcript` replays a synthetic tool reply into an overlay and a panel.
- `detached-panel` supplies a prompt, selector, and actions for detached report replay.

The entry scripts speak the public worker protocol directly and request only host
capabilities. Tool execution is mocked by the tests; the JSON Lines replies use a
small test-only format and make no claim about a provider's output format.
