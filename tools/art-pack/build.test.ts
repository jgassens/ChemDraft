import { execFileSync } from "node:child_process";
import { describe, it } from "vitest";
describe("built-in art pack", () => { it("validates committed SVGs and checksums", () => { execFileSync(process.execPath,["--import","tsx","tools/art-pack/build.mjs","--check"],{cwd:process.cwd(),stdio:"pipe"}); }, 120000); });
