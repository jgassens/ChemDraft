import { describe, expect, it } from "vitest";
import {
  buildRuntimeBuildStatus,
  describeRuntimeBuildStatus,
  serializeRuntimeBuildStatus,
  writeRuntimeBuildStatus,
  RUNTIME_BUILD_STATUS_FILE
} from "./runtimeBuildStatus";

const status = buildRuntimeBuildStatus({
  buildStamp: "9.5.15.29-claude",
  bundleStamp: "chemdraw [claude/chemdraw-keybindings] · 2026-09-08 11:55:23 bac6d96f+dirty",
  runtime: "desktop",
  windowLabel: "main",
  loadedAt: new Date("2026-09-08T16:55:23.000Z"),
  updatedAt: new Date("2026-09-09T12:10:00.000Z"),
  hotUpdates: 3,
  reason: "hot-update"
});

describe("runtime build status", () => {
  it("records what the running window is executing, not what the source says", () => {
    expect(status).toEqual({
      buildStamp: "9.5.15.29-claude",
      bundleStamp: "chemdraw [claude/chemdraw-keybindings] · 2026-09-08 11:55:23 bac6d96f+dirty",
      runtime: "desktop",
      windowLabel: "main",
      loadedAt: "2026-09-08T16:55:23.000Z",
      updatedAt: "2026-09-09T12:10:00.000Z",
      hotUpdates: 3,
      reason: "hot-update"
    });
    // Written as a file for something outside the app to read, so it ends with a newline like every
    // other record this app writes.
    expect(serializeRuntimeBuildStatus(status).endsWith("}\n")).toBe(true);
    expect(JSON.parse(serializeRuntimeBuildStatus(status))).toEqual(status);
    expect(RUNTIME_BUILD_STATUS_FILE).toBe("runtime-build.json");
  });

  it("says how stale the answer is, in units a person reads", () => {
    const at = (isoMinutesLater: number) =>
      new Date(Date.parse(status.updatedAt) + isoMinutesLater * 60000);
    expect(describeRuntimeBuildStatus(status, at(0))).toContain("last seen just now");
    expect(describeRuntimeBuildStatus(status, at(7))).toContain("last seen 7 min ago");
    expect(describeRuntimeBuildStatus(status, at(180))).toContain("last seen 3 h ago");
    // A long session on many hot updates is exactly when a missed reload hides, so the count shows.
    expect(describeRuntimeBuildStatus(status, at(0))).toContain("3 hot updates");
    expect(describeRuntimeBuildStatus({ ...status, hotUpdates: 1 }, at(0))).toContain("1 hot update");
    expect(describeRuntimeBuildStatus({ ...status, hotUpdates: 0 }, at(0))).not.toContain("hot update");
  });

  it("writes nothing in a browser preview, which has no app data directory", async () => {
    // The dynamic import of Tauri's fs plugin would throw here; the web guard returns first.
    await expect(writeRuntimeBuildStatus({ ...status, runtime: "web" })).resolves.toBe(false);
  });
});
