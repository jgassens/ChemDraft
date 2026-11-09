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
// built for the host OS. macOS also accepts --arch arm64|x86_64 (or OPSIN_TARGET_ARCH).
// Intel macOS obtains a pinned Temurin JDK when JAVA_HOME is unset; Intel on arm64 uses Rosetta.
//
// Provenance, the licence audit of the jar, and the module list are in
// apps/desktop/src-tauri/resources/opsin/BUILD.md.
import { spawnSync } from "node:child_process";
import * as filesystem from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertRosettaAvailable, checkOpsinRuntimeArchitecture, jdkInvocation, opsinArchitecturePlan } from "./opsin-runtime-architecture.mjs";
import { acquireIntelMacJdk } from "./opsin-jdk.mjs";

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

export async function buildOpsinRuntime({
  platform = process.platform, hostArch = process.arch, targetArch,
  env = process.env, javaHome = env.JAVA_HOME, rootDir = ROOT_DIR
} = {}, { fs = filesystem, run = spawnSync, acquireJdk = acquireIntelMacJdk, log = console.log } = {}) {
  const { chmodSync, existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } = fs;
  const architecturePlan = opsinArchitecturePlan({
    platform, hostArch, targetArch: targetArch ?? env.OPSIN_TARGET_ARCH, javaHome
  });
  assertRosettaAvailable(architecturePlan, run);
  const acquired = architecturePlan.downloadJdk ? await acquireJdk({ log }) : undefined;
  javaHome = acquired?.javaHome ?? javaHome;
  try {
    const OPSIN_DIR = join(rootDir, "apps", "desktop", "src-tauri", "resources", "opsin");
    const DEST = join(OPSIN_DIR, "jre");
    const JAR = join(OPSIN_DIR, "opsin-cli-2.9.0.jar");
    const exe = platform === "win32" ? ".exe" : "";

    // The module set from `jdeps --print-module-deps --ignore-missing-deps` over the vendored jar.
    // Deliberately the conservative answer: a hand-minimised set is 1 MB smaller but was only ever proven
    // against one SMILES conversion, and would risk failing on OPSIN's CML or InChI output paths.
    //
    // java.desktop is the expensive module and it is log4j-core's doing, not OPSIN's — it reaches
    // java.beans.PropertyChangeEvent, and without it the JVM dies before OPSIN parses anything.
    const MODULES = "java.base,java.compiler,java.desktop,java.management,java.naming,java.rmi,java.scripting,java.sql,jdk.unsupported";

    function onPath(command) {
      const lookup = platform === "win32" ? "where" : "which";
      const result = run(lookup, [command], { encoding: "utf8" });
      return result.status === 0 ? result.stdout.split(/\r?\n/)[0].trim() : undefined;
    }

    function findJlink() {
      if (javaHome && existsSync(join(javaHome, "bin", `jlink${exe}`))) {
        return join(javaHome, "bin", `jlink${exe}`);
      }
      if (javaHome && (architecturePlan.cross || architecturePlan.target === "x86_64")) throw new Error("JAVA_HOME must contain bin/jlink for the target JDK; refusing PATH fallback");
      const fromPath = onPath("jlink");
      if (fromPath) {
        return fromPath;
      }
      const candidates = [];
      if (platform === "darwin") {
        // Homebrew keeps openjdk keg-only, so it is off PATH even when installed.
        candidates.push("/opt/homebrew/opt/openjdk/bin/jlink", "/usr/local/opt/openjdk/bin/jlink");
      }
      if (platform === "win32") {
        // Installers put JDKs here without necessarily exporting JAVA_HOME. Pick the newest across every
        // vendor, by numeric version: a string sort ranks "jdk-8" above "jdk-21", and a per-vendor walk
        // would take an old Adoptium JDK over a newer Microsoft one. Only JDK 21+ qualifies, because the
        // `--compress=zip-9` form below does not exist before it.
        const installed = [];
        for (const vendor of ["Eclipse Adoptium", "Java", "Microsoft", "Zulu"]) {
          const base = join(env.ProgramFiles ?? "C:\\Program Files", vendor);
          if (!existsSync(base)) continue;
          for (const name of readdirSync(base).filter((entry) => /^(jdk|zulu)/i.test(entry))) {
            const version = jdkVersion(name);
            if (version && version[0] >= MIN_JDK_MAJOR) {
              installed.push({ version, jlink: join(base, name, "bin", "jlink.exe") });
            }
          }
        }
        installed.sort((a, b) => compareVersions(b.version, a.version));
        candidates.push(...installed.map((jdk) => jdk.jlink));
      }
      return candidates.find((candidate) => existsSync(candidate));
    }

    const MIN_JDK_MAJOR = 21;

    // The version in a JDK install directory's name, as numbers: "jdk-21.0.4.7-hotspot" → [21, 0, 4, 7],
    // "zulu21.36.17-ca-jdk21.0.4-win_x64" → [21, 36, 17], and the legacy "jdk1.8.0_392" → [8, 0, 392].
    function jdkVersion(name) {
      const match = /(\d+(?:[._]\d+)*)/.exec(name);
      if (!match) return undefined;
      const parts = match[1].split(/[._]/).map(Number);
      return parts[0] === 1 && parts.length > 1 ? parts.slice(1) : parts;
    }

    function compareVersions(a, b) {
      for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0) return difference;
      }
      return 0;
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
      throw new Error("No jlink found. Install a JDK (e.g. brew install openjdk, or Temurin on Windows) or set JAVA_HOME.");
    }

    log(`Using ${jlink}`);
    function checkRuntimeArchitecture(root) {
      checkOpsinRuntimeArchitecture(root, architecturePlan.target, readFileSync);
    }
    if (platform === "darwin") {
      // Check the selected JDK before removing the previous image. jlink cannot change JMOD CPU type.
      let jdkHome = dirname(dirname(realpathSync(jlink)));
      // Apple's /usr/bin/jlink is a launcher, not the JDK. Preserve the old default discovery,
      // but inspect the JDK the launcher selects instead of mistaking /usr for JAVA_HOME.
      if (jdkHome === "/usr") {
        const selected = run("/usr/libexec/java_home", [], { encoding: "utf8" });
        if (selected.status !== 0 || !selected.stdout.trim()) throw new Error("Could not resolve the JDK used by /usr/bin/jlink; set JAVA_HOME");
        jdkHome = selected.stdout.trim();
      }
      checkRuntimeArchitecture(jdkHome);
    }
    rmSync(DEST, { recursive: true, force: true });
    const linkArgs = ["--add-modules", MODULES, "--strip-debug", "--no-header-files", "--no-man-pages", "--compress=zip-9", "--output", DEST];
    const link = run(
      ...jdkInvocation(jlink, linkArgs, architecturePlan),
      { stdio: "inherit" }
    );
    if (link.status !== 0) {
      throw new Error(`jlink failed: ${link.error?.message ?? `exit ${link.status}`}`);
    }
    makeWritable(DEST);
    if (platform === "darwin") checkRuntimeArchitecture(DEST);
    log(`Built ${(sizeOf(DEST) / 1024 / 1024).toFixed(0)}M runtime at ${DEST}`);

    // Prove it before declaring success: a runtime that cannot run OPSIN is worse than none, because the
    // capability would report itself available.
    if (existsSync(JAR)) {
      const smoke = run(...jdkInvocation(join(DEST, "bin", `java${exe}`), ["-jar", JAR, "-o", "smi"], architecturePlan), {
        input: "benzene\n",
        encoding: "utf8"
      });
      const out = (smoke.stdout ?? "").split(/\r?\n/)[0].trim();
      if (smoke.status === 0 && out === "C1=CC=CC=C1") {
        log(`smoke ok: benzene -> ${out}`);
      } else {
        throw new Error(`Runtime built but OPSIN did not convert benzene (got '${out}'): ${smoke.stderr ?? ""}`);
      }
    } else {
      console.error(`warning: ${JAR} not found, skipping smoke test`);
    }
  } finally {
    await acquired?.cleanup();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { arch: { type: "string" }, target: { type: "string", short: "t" } } });
    if (values.arch && values.target) throw new Error("Specify only one of --arch or --target");
    await buildOpsinRuntime({ targetArch: values.arch ?? values.target });
  } catch (error) {
    console.error(`OPSIN runtime build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
