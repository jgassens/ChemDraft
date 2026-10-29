// Resource limits shared by the two Linux builders. Never signal a process we did not start.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const GiB = 1024 ** 3;

function expandCpuMask(mask) {
  return mask.trim().split(",").flatMap((part) => {
    const [first, last = first] = part.split("-").map(Number);
    return Array.from({ length: last - first + 1 }, (_, index) => first + index);
  });
}

export function linuxBuildCpuList(allowedMask, onlineMask) {
  const online = expandCpuMask(onlineMask);
  const cpus = expandCpuMask(allowedMask).filter((cpu) => online.includes(cpu));
  const outside = online.filter((cpu) => !cpus.includes(cpu)).length;
  // Parent taskset restrictions already leave CPUs unused by this build. Count them so a
  // nested terminal build does not cut three more CPUs and fail on a four-core machine.
  const reserve = Math.max(0, 3 - outside);
  if (cpus.length <= reserve) throw new Error("At least four online CPUs are required to reserve three for the OS.");
  return cpus.slice(0, cpus.length - reserve).join(",");
}

export function reserveLinuxBuildCpus() {
  const mask = /^Cpus_allowed_list:\s*(.+)$/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1];
  if (!mask) throw new Error("Cannot determine available CPUs from /proc/self/status.");
  const allowed = linuxBuildCpuList(mask, readFileSync("/sys/devices/system/cpu/online", "utf8"));
  const result = spawnSync("taskset", ["--all-tasks", "--pid", "--cpu-list", allowed, String(process.pid)], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not reserve three CPUs for the operating system: ${result.stderr.trim()}`);
  console.log(`Build CPU affinity: ${allowed}; at least three online CPUs remain outside this build.`);
  return allowed;
}

function existingAncestor(path) {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error(`No existing filesystem ancestor for ${path}.`);
    current = parent;
  }
  return current;
}

function availableBytes(path) {
  const disk = statfsSync(existingAncestor(path));
  return disk.bavail * disk.bsize;
}

export function checkLinuxBuildDisk(paths, freeBytes = availableBytes) {
  for (const [path, minimum] of [["/", 10], ...[...new Set([homedir(), ...paths].map((path) => resolve(path)))].map((path) => [path, 20])]) {
    const free = freeBytes(path);
    if (!Number.isFinite(free) || free < minimum * GiB) {
      throw new Error(`Disk reserve reached at ${path}: ${(free / GiB).toFixed(2)} GiB free; ${minimum} GiB required. Build stopped.`);
    }
  }
}

function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function stopOwnGroup(child, graceMs) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) return;
  const signal = (name) => {
    try { process.kill(-child.pid, name); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  signal("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && groupAlive(child.pid)) {
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(100, graceMs)));
  }
  if (groupAlive(child.pid)) signal("SIGKILL");
}

export function createLinuxBuildGuard(paths, { freeBytes = availableBytes, intervalMs = 10_000, graceMs = 5000, logger = console } = {}) {
  const check = () => checkLinuxBuildDisk(paths, freeBytes);
  check();
  logger.log("Disk guard: keeping 20 GiB free on home/build volumes and 10 GiB on root; checking every 10 seconds during build steps.");
  return {
    check,
    async run(command, args, options = {}) {
      check();
      logger.log(`> ${command} ${args.map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(" ")}`);
      const child = spawn(command, args, { stdio: "inherit", ...options, detached: true });
      let stopped;
      let termination;
      const abort = (error) => {
        if (stopped) return;
        stopped = error;
        logger.error(`${error.message} Terminating only the current build process group (${child.pid}).`);
        termination = stopOwnGroup(child, graceMs);
        // The close handler awaits this promise; retain an immediate handler as well.
        termination.catch(() => {});
      };
      const interrupt = (signal) => abort(new Error(`Build interrupted by ${signal}.`));
      const onInterrupt = () => interrupt("SIGINT");
      const onTerminate = () => interrupt("SIGTERM");
      process.once("SIGINT", onInterrupt);
      process.once("SIGTERM", onTerminate);
      const monitor = setInterval(() => { try { check(); } catch (error) { abort(error); } }, intervalMs);
      try {
        const result = await new Promise((resolveResult, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => resolveResult({ code, signal }));
        });
        if (termination) await termination;
        if (stopped) throw stopped;
        if (result.code !== 0) throw new Error(`${command} failed (${result.signal ?? result.code}).`);
        check();
      } finally {
        clearInterval(monitor);
        process.removeListener("SIGINT", onInterrupt);
        process.removeListener("SIGTERM", onTerminate);
      }
    }
  };
}
