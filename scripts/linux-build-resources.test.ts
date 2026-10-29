import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkLinuxBuildDisk, createLinuxBuildGuard, linuxBuildCpuList } from "./linux-build-resources.mjs";

const GiB = 1024 ** 3;
const silent = { log() {}, error() {} };
const temporary: string[] = [];
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "chemdraft-disk-guard-"));
  temporary.push(path);
  return path;
};
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("Linux build disk reserve", () => {
  it("reserves three CPUs once, including nested builds on the minimum four-core host", () => {
    expect(linuxBuildCpuList("0-11", "0-11")).toBe("0,1,2,3,4,5,6,7,8");
    expect(linuxBuildCpuList("0-8", "0-11")).toBe("0,1,2,3,4,5,6,7,8");
    expect(linuxBuildCpuList("0-11", "0-7")).toBe("0,1,2,3,4");
    expect(linuxBuildCpuList("0-3", "0-3")).toBe("0");
    expect(linuxBuildCpuList("0", "0-3")).toBe("0");
    expect(linuxBuildCpuList("4-7,10", "0-11")).toBe("4,5,6,7,10");
    expect(() => linuxBuildCpuList("0-2", "0-2")).toThrow("At least four");
  });

  it("enforces the root, home and separate build-volume floors before starting work", () => {
    const build = directory();
    for (const [lowPath, free] of [["/", 9.99], [homedir(), 19.99], [build, 19.99]] as const) {
      expect(() => checkLinuxBuildDisk([build], (path: string) => (path === lowPath ? free : 100) * GiB))
        .toThrow(`Disk reserve reached at ${lowPath}`);
    }
    expect(() => checkLinuxBuildDisk([build], (path: string) => (path === "/" ? 10 : 20) * GiB)).not.toThrow();
  });

  it("refuses the next command after available space falls, without running it", async () => {
    const build = directory();
    const marker = join(build, "unexpected-child");
    let free = 100 * GiB;
    const guard = createLinuxBuildGuard([build], { freeBytes: () => free, logger: silent });
    free = 0;
    await expect(guard.run(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`], { stdio: "ignore" }))
      .rejects.toThrow("Disk reserve reached");
    expect(existsSync(marker)).toBe(false);
  });

  it("reports ordinary command failures and releases its signal listeners", async () => {
    const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const guard = createLinuxBuildGuard([directory()], { freeBytes: () => 100 * GiB, logger: silent });
    await expect(guard.run(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" })).rejects.toThrow("failed (7)");
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
    await expect(guard.run("chemdraft-nonexistent-test-command", [], { stdio: "ignore" })).rejects.toThrow();
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
  });

  it.runIf(process.platform === "linux")("stops its running compiler group and descendants while leaving unrelated processes alive", async () => {
    const build = directory();
    const ready = join(build, "grandchild-ready");
    const stopped = join(build, "grandchild-stopped");
    const reaped = join(build, "grandchild-reaped");
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const unrelatedClosed = new Promise((resolve) => unrelated.once("close", resolve));
    const grandchild = `
      const fs = require('node:fs');
      process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(stopped)}, 'SIGTERM'); process.exit(0); });
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      setInterval(() => {}, 1000);
    `;
    const compiler = `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {});
      const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });
      child.on('exit', () => fs.writeFileSync(${JSON.stringify(reaped)}, 'reaped'));
      setInterval(() => {}, 1000);
    `;
    const guard = createLinuxBuildGuard([build], {
      freeBytes: () => (existsSync(ready) ? 0 : 100 * GiB), intervalMs: 20, graceMs: 500, logger: silent
    });
    try {
      await expect(guard.run(process.execPath, ["-e", compiler], { stdio: "ignore" })).rejects.toThrow("Disk reserve reached");
      expect(readFileSync(stopped, "utf8")).toBe("SIGTERM");
      expect(readFileSync(reaped, "utf8")).toBe("reaped");
      expect(unrelated.kill(0)).toBe(true);
    } finally {
      unrelated.kill("SIGKILL");
      await unrelatedClosed;
    }
  });
});
