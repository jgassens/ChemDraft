#!/usr/bin/env node
// Build the trimmed Java runtime that backs name → structure.
//
// Why this is a script and not a committed artifact: the image is ~47 MB, which is a poor thing to
// carry in git forever, and unlike the WASM engines it is reproducible from any JDK in under a minute.
// A build WITHOUT it still works — the OPSIN capability reports itself unavailable with a reason
// (`opsin_status`), the same way a missing engine is handled everywhere else in this repo. Run this
// before packaging a release, or whenever you want the feature live in a dev build.
//
// Cross-platform (macOS, Windows, Linux); `build-opsin-runtime.sh` delegates here. The runtime is
// built for the host platform only — a Windows installer needs a runtime built on Windows.
//
// Provenance, the licence audit of the jar, and the module list are in
// apps/desktop/src-tauri/resources/opsin/BUILD.md.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const OPSIN_DIR = join(ROOT_DIR, "apps", "desktop", "src-tauri", "resources", "opsin");
const DEST = join(OPSIN_DIR, "jre");
const JAR = join(OPSIN_DIR, "opsin-cli-2.9.0.jar");
const exe = process.platform === "win32" ? ".exe" : "";

// The module set from `jdeps --print-module-deps --ignore-missing-deps` over the vendored jar.
// Deliberately the conservative answer: a hand-minimised set is 1 MB smaller but was only ever proven
// against one SMILES conversion, and would risk failing on OPSIN's CML or InChI output paths.
//
// java.desktop is the expensive module and it is log4j-core's doing, not OPSIN's — it reaches
// java.beans.PropertyChangeEvent, and without it the JVM dies before OPSIN parses anything.
const MODULES = "java.base,java.compiler,java.desktop,java.management,java.naming,java.rmi,java.scripting,java.sql,jdk.unsupported";

function onPath(command) {
  const lookup = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookup, [command], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.split(/\r?\n/)[0].trim() : undefined;
}

function findJlink() {
  const javaHome = process.env.JAVA_HOME;
  if (javaHome && existsSync(join(javaHome, "bin", `jlink${exe}`))) {
    return join(javaHome, "bin", `jlink${exe}`);
  }
  const fromPath = onPath("jlink");
  if (fromPath) {
    return fromPath;
  }
  const candidates = [];
  if (process.platform === "darwin") {
    // Homebrew keeps openjdk keg-only, so it is off PATH even when installed.
    candidates.push("/opt/homebrew/opt/openjdk/bin/jlink", "/usr/local/opt/openjdk/bin/jlink");
  }
  if (process.platform === "win32") {
    // Installers put JDKs here without necessarily exporting JAVA_HOME; newest first.
    for (const vendor of ["Eclipse Adoptium", "Java", "Microsoft", "Zulu"]) {
      const base = join(process.env.ProgramFiles ?? "C:\\Program Files", vendor);
      if (!existsSync(base)) continue;
      for (const jdk of readdirSync(base).filter((name) => /^(jdk|zulu)/i.test(name)).sort().reverse()) {
        candidates.push(join(base, jdk, "bin", "jlink.exe"));
      }
    }
  }
  return candidates.find((candidate) => existsSync(candidate));
}

// jlink emits its legal/ notices read-only, and Tauri's resource copier overwrites rather than
// replaces — so the SECOND build fails with EACCES on files the first build already copied. Making
// them writable is what keeps a rebuild working. The files themselves must stay: they are the
// GPLv2+CE and Classpath Exception texts this runtime is redistributed under.
function makeWritable(path) {
  const stat = statSync(path);
  chmodSync(path, stat.mode | 0o200);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) makeWritable(join(path, entry));
  }
}

function sizeOf(path) {
  const stat = statSync(path);
  return stat.isDirectory() ? readdirSync(path).reduce((sum, entry) => sum + sizeOf(join(path, entry)), 0) : stat.size;
}

const jlink = findJlink();
if (!jlink) {
  console.error("error: no jlink found. Install a JDK (e.g. 'brew install openjdk', or Temurin on Windows) or set JAVA_HOME.");
  process.exit(1);
}

console.log(`Using ${jlink}`);
rmSync(DEST, { recursive: true, force: true });
const link = spawnSync(
  jlink,
  ["--add-modules", MODULES, "--strip-debug", "--no-header-files", "--no-man-pages", "--compress=zip-9", "--output", DEST],
  { stdio: "inherit" }
);
if (link.status !== 0) {
  process.exit(link.status ?? 1);
}
makeWritable(DEST);
console.log(`Built ${(sizeOf(DEST) / 1024 / 1024).toFixed(0)}M runtime at ${DEST}`);

// Prove it before declaring success: a runtime that cannot run OPSIN is worse than none, because the
// capability would report itself available.
if (existsSync(JAR)) {
  const smoke = spawnSync(join(DEST, "bin", `java${exe}`), ["-jar", JAR, "-o", "smi"], {
    input: "benzene\n",
    encoding: "utf8"
  });
  const out = (smoke.stdout ?? "").split(/\r?\n/)[0].trim();
  if (out === "C1=CC=CC=C1") {
    console.log(`smoke ok: benzene -> ${out}`);
  } else {
    console.error(`error: runtime built but OPSIN did not convert benzene (got '${out}')`);
    process.exit(1);
  }
} else {
  console.error(`warning: ${JAR} not found, skipping smoke test`);
}
