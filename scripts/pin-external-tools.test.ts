import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { formatToolPin, parseClaudeLatestVersion, pinDiff, singleArchiveEntryName } from "./pin-external-tools.mjs";

describe("external tool pin script", () => {
  it("formats a ToolPin exactly as pins.rs does", () => {
    expect(formatToolPin({ tool: "Claude", platform: "DarwinArm64", version: "CLAUDE_VERSION", url: "https://example.test/claude", size: 42, sha256: "abc", archive: "Raw", entry: "claude", binary: "claude" })).toBe(`    ToolPin {\n        tool: ToolId::Claude,\n        platform: ToolPlatform::DarwinArm64,\n        version: CLAUDE_VERSION,\n        url: "https://example.test/claude",\n        size: 42,\n        sha256: "abc",\n        archive: ArchiveKind::Raw,\n        entry: "claude",\n        binary: "claude",\n    },`);
  });

  it("parses the plain-text Claude latest version and rejects JSON or malformed versions", () => {
    expect(parseClaudeLatestVersion("2.1.308\n")).toBe("2.1.308");
    expect(() => parseClaudeLatestVersion('{"version":"2.1.308"}')).toThrow("Invalid Claude latest version.");
    expect(() => parseClaudeLatestVersion("2.1")).toThrow("Invalid Claude latest version.");
  });

  it("validates one-entry tar.gz and zip archives", () => {
    const header = Buffer.alloc(512); header.write("codex", 0); header.write("00000000001\0", 124); header[156] = 48;
    expect(singleArchiveEntryName("tar.gz", gzipSync(Buffer.concat([header, Buffer.from("x"), Buffer.alloc(511), Buffer.alloc(1024)])))).toBe("codex");
    const zip = Buffer.alloc(46 + 5); zip.writeUInt32LE(0x02014b50, 0); zip.writeUInt16LE(5, 28); zip.write("codex", 46);
    expect(singleArchiveEntryName("zip", zip)).toBe("codex");
  });

  it("reports a pin difference", () => {
    expect(pinDiff("pub const CLAUDE_VERSION: &str = \"1\";\npub const PINS: [ToolPin; 6] = [\n];", "new")).toBe("Published external-tool pins differ from pins.rs.");
    expect(pinDiff("prefix\npub const CLAUDE_VERSION: &str = \"1\";\npub const PINS: [ToolPin; 6] = [\n];", "pub const CLAUDE_VERSION: &str = \"1\";\npub const PINS: [ToolPin; 6] = [\n];")).toBe("");
  });
});
