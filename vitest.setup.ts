// The suite is authored Mac-first: glyph shortcut labels, Cmd-bound shortcuts resolving on
// metaKey. Node 21+ (and jsdom) expose a real `navigator.platform`, so anything that auto-detects the
// platform would follow the HOST OS and the same test would assert different things on the macOS,
// Linux and Windows CI runners. Pin it to macOS; a test that exercises another platform passes
// `platform` explicitly (see shortcut-engine and toolsets tests).
if (globalThis.navigator) {
  Object.defineProperty(globalThis.navigator, "platform", { value: "MacIntel", configurable: true });
}
