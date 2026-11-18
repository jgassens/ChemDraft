// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("the generated Eigen config accepts a Windows path with spaces", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "uff-eigen-config-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  writeFileSync(join(scratch, "CMakeLists.txt"), `
cmake_minimum_required(VERSION 3.24)
project(TestEigenConfig NONE)
include("\${EIGEN_CONFIG_MODULE}")
find_package(Eigen3 CONFIG REQUIRED PATHS "\${Eigen3_DIR}" NO_DEFAULT_PATH)
get_target_property(include_dir Eigen3::Eigen INTERFACE_INCLUDE_DIRECTORIES)
if(NOT include_dir STREQUAL "C:/Users/Research Lab/eigen" OR
   NOT EIGEN3_INCLUDE_DIR STREQUAL include_dir)
  message(FATAL_ERROR "Unexpected Eigen include directories: \${include_dir}, \${EIGEN3_INCLUDE_DIR}")
endif()
`);
  const module = fileURLToPath(new URL("./eigen-config.cmake", import.meta.url));
  const result = spawnSync(process.env.CMAKE ?? "cmake", [
    "-S", scratch, "-B", join(scratch, "build"),
    `-DEIGEN_CONFIG_MODULE=${module}`,
    String.raw`-DEIGEN_SOURCE=C:\Users\Research Lab\eigen`,
  ], { encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
