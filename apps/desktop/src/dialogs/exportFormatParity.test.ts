import { readFileSync } from "node:fs";
import { exportFormatDescriptors } from "@chemdraft/export-engine";
import { expect, it } from "vitest";

it("keeps the native Export format allowlist in sync with the shared descriptors", () => {
  const source = readFileSync(new URL("../../src-tauri/src/dialog_windows.rs", import.meta.url), "utf8");
  const allowlist = source.match(/matches!\(\s*self\.format\.as_str\(\),([\s\S]*?)\)\s*&&/);
  expect(allowlist, "Rust Export format validation must have an inspectable allowlist").not.toBeNull();
  const formats = [...allowlist![1]!.matchAll(/"([^"]+)"/g)].map(match => match[1]);
  expect(formats.sort()).toEqual(exportFormatDescriptors.map(descriptor => descriptor.id).sort());
});
