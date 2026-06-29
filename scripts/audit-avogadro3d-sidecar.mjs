import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sidecarRoot = join(repoRoot, "native", "avogadro3d-sidecar");
const cmake = readFileSync(join(sidecarRoot, "CMakeLists.txt"), "utf8");
const preset = readFileSync(join(sidecarRoot, "CMakePresets.json"), "utf8");
const tauriConfig = readFileSync(join(repoRoot, "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8");

const failures = [];

const requiredCmakeSnippets = [
  "set(CMAKE_CXX_STANDARD 17)",
  "CHEMDRAFT_AVOGADRO3D_ENABLE_OPENBABEL \"Allow Open Babel linkage\" OFF",
  "CHEMDRAFT_AVOGADRO3D_ENABLE_GPL_PLUGINS \"Allow GPL plugin linkage\" OFF",
  "416651ddaef33a4e20392392e7c0b505d446491b"
];

for (const snippet of requiredCmakeSnippets) {
  if (!cmake.includes(snippet)) {
    failures.push(`Missing CMake guard: ${snippet}`);
  }
}

const forbiddenCmakePatterns = [
  /\bfind_package\s*\(\s*OpenBabel/i,
  /\btarget_link_libraries\s*\([^)]*\bOpenBabel\b/i,
  /\bBUILD_GPL_PLUGINS\b[^"\n]*ON/i
];

for (const pattern of forbiddenCmakePatterns) {
  if (pattern.test(cmake)) {
    failures.push(`Forbidden sidecar linkage pattern matched: ${pattern}`);
  }
}

const presetJson = JSON.parse(preset);
const protocolScout = presetJson.configurePresets?.find((entry) => entry.name === "protocol-scout");
const cacheVariables = protocolScout?.cacheVariables ?? {};
for (const variable of [
  "CHEMDRAFT_AVOGADRO3D_ENABLE_OPENBABEL",
  "CHEMDRAFT_AVOGADRO3D_ENABLE_GPL_PLUGINS",
  "CHEMDRAFT_AVOGADRO3D_ENABLE_PYTHON",
  "CHEMDRAFT_AVOGADRO3D_ENABLE_TESTS",
  "CHEMDRAFT_AVOGADRO3D_ENABLE_BENCHMARKS",
  "CHEMDRAFT_AVOGADRO3D_ENABLE_PLOTTER",
  "CHEMDRAFT_AVOGADRO3D_ENABLE_LIBARCHIVE",
  "CHEMDRAFT_AVOGADRO3D_ENABLE_LIBMSYM",
  "CHEMDRAFT_AVOGADRO3D_ENABLE_SPGLIB"
]) {
  if (cacheVariables[variable] !== "OFF") {
    failures.push(`${variable} must be OFF in protocol-scout preset.`);
  }
}

const config = JSON.parse(tauriConfig);
if (!config.bundle?.externalBin?.includes("binaries/avogadro3d-sidecar")) {
  failures.push("Tauri bundle.externalBin must include binaries/avogadro3d-sidecar.");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("avogadro3d-sidecar audit passed");
