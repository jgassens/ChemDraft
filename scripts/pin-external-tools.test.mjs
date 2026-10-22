import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { formatToolPin, pinDiff, singleArchiveEntryName } from "./pin-external-tools.mjs";

test("formats a ToolPin exactly as pins.rs does", () => {
  assert.equal(formatToolPin({ tool: "Claude", platform: "DarwinArm64", version: "CLAUDE_VERSION", url: "https://example.test/claude", size: 42, sha256: "abc", archive: "Raw", entry: "claude", binary: "claude" }), `    ToolPin {\n        tool: ToolId::Claude,\n        platform: ToolPlatform::DarwinArm64,\n        version: CLAUDE_VERSION,\n        url: "https://example.test/claude",\n        size: 42,\n        sha256: "abc",\n        archive: ArchiveKind::Raw,\n        entry: "claude",\n        binary: "claude",\n    },`);
});

test("validates one-entry tar.gz and zip archives", () => {
  const header = Buffer.alloc(512); header.write("codex", 0); header.write("00000000001\0", 124); header[156] = 48;
  assert.equal(singleArchiveEntryName("tar.gz", gzipSync(Buffer.concat([header, Buffer.from("x"), Buffer.alloc(511), Buffer.alloc(1024)]))), "codex");
  const zip = Buffer.alloc(46 + 5); zip.writeUInt32LE(0x02014b50, 0); zip.writeUInt16LE(5, 28); zip.write("codex", 46);
  assert.equal(singleArchiveEntryName("zip", zip), "codex");
});

test("reports a pin difference", () => {
  assert.equal(pinDiff("pub const CLAUDE_VERSION: &str = \"1\";\npub const PINS: [ToolPin; 6] = [\n];", "new"), "Published external-tool pins differ from pins.rs.");
  assert.equal(pinDiff("prefix\npub const CLAUDE_VERSION: &str = \"1\";\npub const PINS: [ToolPin; 6] = [\n];", "pub const CLAUDE_VERSION: &str = \"1\";\npub const PINS: [ToolPin; 6] = [\n];"), "");
});
