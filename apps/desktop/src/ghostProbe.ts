// TEMPORARY DIAGNOSTIC — self-driving ghost-hunt loop (not shipped; gated on ?ghostProbe=1).
//
// Drives the proven ghost gesture (Shift-hover raise → release → move away, plus a
// drag-while-Shift variant) over the document's graphic objects from INSIDE the app,
// so no OS-level input is needed. Between iterations it force-repaints the board so
// each iteration starts from a clean paint field. A HUD names the current experiment,
// gesture flavor, and target so an outside screenshot can attribute any ghost pixels.
// CSS experiments are applied via an injected <style> tag — the working tree's
// App.css is never touched while a live user session shares the dev server.

import { resolveAgentBridgePermission } from "./agentBridge";

type Bridge = NonNullable<(typeof window)["__CHEMDRAFT_AGENT__"]>;

interface GraphicTarget {
  id: string;
  rotated: boolean;
  label: string;
}

const EXPERIMENTS: ReadonlyArray<{ name: string; css: string }> = [
  { name: "baseline (HEAD css)", css: "" },
  {
    name: "frame-composited",
    css: ".object-transform-frame { transform: translateZ(0); }"
  },
  {
    name: "willchange-rot (revert fix2)",
    css: ".graphic-visual-shell[data-art-z-rotation] { will-change: transform; }"
  },
  {
    name: "board-contain-none",
    css: ".document-board { contain: none !important; }"
  },
  {
    name: "no-isolation",
    css: ".document-board { isolation: auto !important; }"
  },
  {
    name: "page-contain-none",
    css: ".page { contain: none !important; }"
  }
];

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function hud(): HTMLElement {
  let node = document.getElementById("ghost-probe-hud");
  if (!node) {
    node = document.createElement("div");
    node.id = "ghost-probe-hud";
    node.style.cssText =
      "position:fixed;top:6px;left:6px;z-index:2147483647;padding:8px 14px;" +
      "background:#111;color:#7CFFB2;font:700 15px/1.4 -apple-system,monospace;" +
      "border-radius:8px;white-space:pre;pointer-events:none;";
    document.body.appendChild(node);
  }
  return node;
}

function setExperimentCss(css: string): void {
  let tag = document.getElementById("ghost-probe-exp") as HTMLStyleElement | null;
  if (!tag) {
    tag = document.createElement("style");
    tag.id = "ghost-probe-exp";
    document.head.appendChild(tag);
  }
  tag.textContent = css;
}

// Flip a CSS var consumed by the page background (and the crosshair gradient), which
// repaints the whole page area — the same effect that made HMR injections clear
// ghosts during the morning bisect. Two flips: dirty then back to normal.
async function resetPaintField(): Promise<void> {
  const root = document.documentElement;
  root.style.setProperty("--cd-bg-page", "#fffefd");
  await wait(90);
  root.style.removeProperty("--cd-bg-page");
  await wait(140);
}

function pressShift(): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true, bubbles: true }));
}

function releaseShift(): void {
  window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", shiftKey: false, bubbles: true }));
}

async function hoverGesture(bridge: Bridge, target: GraphicTarget): Promise<void> {
  pressShift();
  bridge.pointerMove({ objectId: target.id }, { buttons: 0, shiftKey: true });
  await wait(350);
  bridge.pointerMove({ objectId: target.id, anchor: "topLeft" }, { buttons: 0, shiftKey: true });
  await wait(300);
  releaseShift();
  bridge.pointerMove({ page: { x: 40, y: 40 } }, { buttons: 0 });
  await wait(250);
}

// Shift-raise the box, then drag the object a short hop and back while Shift stays
// down — the flow that stacked several ghost button pairs for the user. The document
// mutation is reverted with edit.undo AFTER the observation pause in the caller.
async function dragGesture(bridge: Bridge, target: GraphicTarget): Promise<boolean> {
  pressShift();
  bridge.pointerMove({ objectId: target.id }, { buttons: 0, shiftKey: true });
  await wait(300);
  const from = bridge.resolvePoint({ objectId: target.id });
  bridge.pointerDown({ objectId: target.id }, { shiftKey: true });
  for (let step = 1; step <= 5; step += 1) {
    bridge.pointerMove(
      { page: { x: from.page.x + step * 9, y: from.page.y - step * 6 } },
      { buttons: 1, shiftKey: true }
    );
    await wait(60);
  }
  bridge.pointerUp(
    { page: { x: from.page.x + 45, y: from.page.y - 30 } },
    { shiftKey: true }
  );
  await wait(200);
  releaseShift();
  bridge.pointerMove({ page: { x: 40, y: 40 } }, { buttons: 0 });
  await wait(250);
  return true;
}

function graphicTargets(bridge: Bridge): GraphicTarget[] {
  const objects = bridge.snapshot().document.pages[0]?.objects ?? [];
  const targets: GraphicTarget[] = [];
  for (const object of objects) {
    if (object.type !== "graphic") {
      continue;
    }
    const data = (object as { data?: { rotation?: unknown; artToolId?: unknown } }).data;
    const rotation = typeof data?.rotation === "number" ? data.rotation : 0;
    const rotated = rotation !== 0 && Math.abs(rotation % 360) > 0.01;
    targets.push({
      id: object.id,
      rotated,
      label: `${String(data?.artToolId ?? "graphic")}${rotated ? " (rotated)" : ""}`
    });
  }
  // Rotated art ghosts hardest; probe it first, but keep an unrotated control in the mix.
  targets.sort((a, b) => Number(b.rotated) - Number(a.rotated));
  return targets.slice(0, 4);
}

export async function installGhostProbe(): Promise<void> {
  const banner = hud();
  banner.textContent = "ghost probe: waiting for agent bridge…";

  // Pin the window to every Space and the top of the z-order FIRST, so the HUD is
  // observable even while later steps (bridge discovery) are still failing.
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const appWindow = getCurrentWindow();
    await appWindow.setVisibleOnAllWorkspaces(true).catch(() => undefined);
    await appWindow.setAlwaysOnTop(true).catch(() => undefined);
    void appWindow.setFocus().catch(() => undefined);
  } catch {
    // Observation convenience only.
  }
  let bridge: Bridge | undefined;
  for (let attempt = 0; attempt < 240 && !bridge; attempt += 1) {
    bridge = window.__CHEMDRAFT_AGENT__ ?? undefined;
    if (!bridge) {
      if (attempt % 10 === 0) {
        let raw = "";
        try {
          const core = await import("@tauri-apps/api/core");
          raw = JSON.stringify(await core.invoke("agent_bridge_status"));
        } catch (error) {
          raw = `invoke threw: ${String(error)}`;
        }
        try {
          const permission = await resolveAgentBridgePermission();
          banner.textContent =
            `ghost probe: waiting for bridge (${attempt})\n` +
            `permission: enabled=${permission.enabled} source=${permission.source}\n` +
            `raw: ${raw}`;
        } catch (error) {
          banner.textContent = `ghost probe: permission check threw\n${String(error)}\nraw: ${raw}`;
        }
      }
      await wait(500);
    }
  }
  if (!bridge) {
    banner.textContent += "\nghost probe: NO BRIDGE — gave up";
    return;
  }

  await wait(2500);
  let targets: GraphicTarget[] = [];
  for (let attempt = 0; attempt < 40 && targets.length === 0; attempt += 1) {
    targets = graphicTargets(bridge);
    if (targets.length === 0) {
      banner.textContent = `ghost probe: waiting for session restore… (${attempt})`;
      await wait(500);
    }
  }
  if (targets.length === 0) {
    banner.textContent = "ghost probe: no graphic objects in document";
    return;
  }

  // Select tool, so the drag flavor moves objects instead of drawing with a leftover tool.
  await bridge.command("tool.select");

  // Keep pulling the window to the front so an outside observer's display follows it
  // across Spaces; without this the window can sit on an unreachable Space.
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const appWindow = getCurrentWindow();
    // Pin the probe window to every Space and the top of the z-order so an outside
    // observer can watch it no matter which Space is active.
    await appWindow.setVisibleOnAllWorkspaces(true).catch(() => undefined);
    await appWindow.setAlwaysOnTop(true).catch(() => undefined);
    const pullForward = () => {
      void appWindow.setFocus().catch(() => undefined);
    };
    pullForward();
    setInterval(pullForward, 15000);
  } catch {
    // Window pinning is a convenience for observation; the probe runs without it.
  }

  let cycle = 0;
  for (;;) {
    cycle += 1;
    for (const experiment of EXPERIMENTS) {
      setExperimentCss(experiment.css);
      for (const target of targets) {
        for (const flavor of ["hover", "drag"] as const) {
          await resetPaintField();
          banner.textContent =
            `cycle ${cycle} · exp: ${experiment.name}\n` +
            `target: ${target.label} [${target.id}]\n` +
            `gesture: ${flavor} — field was reset; ghosts below are FRESH`;
          if (flavor === "hover") {
            await hoverGesture(bridge, target);
            await wait(2600);
          } else {
            const moved = await dragGesture(bridge, target);
            await wait(2600);
            if (moved) {
              await bridge.command("edit.undo");
              await wait(300);
            }
          }
        }
      }
    }
  }
}
