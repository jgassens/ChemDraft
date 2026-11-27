import { describe, expect, it } from "vitest";

import { INSTALLED_PLUGIN_WORKER_CSP } from "./installedPluginAssetPath";
import { describeWorkerCspFailure, evaluateWorkerCsp } from "./workerCspPolicy";

describe("evaluateWorkerCsp", () => {
  it("accepts the worker policy itself, and stricter ones", () => {
    expect(evaluateWorkerCsp(INSTALLED_PLUGIN_WORKER_CSP)).toEqual({ ok: true });
    expect(evaluateWorkerCsp("default-src 'none'")).toEqual({ ok: true });
    expect(evaluateWorkerCsp("DEFAULT-SRC 'NONE'; Script-Src 'self'; connect-src 'self'")).toEqual({ ok: true });
    // Several policies are all enforced, so one strict policy beside a loose one is enough.
    expect(evaluateWorkerCsp(`connect-src *, ${INSTALLED_PLUGIN_WORKER_CSP}`)).toEqual({ ok: true });
  });

  it("refuses a missing or empty header", () => {
    expect(evaluateWorkerCsp(null)).toEqual({ ok: false, reason: "missing" });
    expect(evaluateWorkerCsp("  ")).toEqual({ ok: false, reason: "missing" });
  });

  it("refuses any policy that lets the worker reach further than the reference", () => {
    const weaker = [
      ["default-src 'none'; connect-src https://evil.example", "connect-src"],
      ["default-src 'none'; connect-src 'none' https://evil.example", "connect-src"],
      ["script-src 'self'; worker-src 'self'", "connect-src"],
      ["default-src *", "connect-src"],
      ["default-src 'self'", "child-src"],
      ["default-src 'none'; script-src 'self' https://cdn.example", "script-src"],
      ["default-src 'none'; script-src 'self' 'unsafe-eval'", "script-src"],
      ["default-src 'none'; script-src 'self' data:", "script-src"],
      ["default-src 'none'; connect-src 'self'; connect-src 'self'; img-src https:", "img-src"],
      ["default-src 'none'; child-src https://x.example", "worker-src"]
    ] as const;
    for (const [policy, directive] of weaker) {
      const verdict = evaluateWorkerCsp(policy);
      expect(verdict, policy).toMatchObject({ ok: false, reason: "weaker", directive });
    }
  });

  it("explains a refusal specifically", () => {
    expect(describeWorkerCspFailure({ ok: false, reason: "missing" })).toBe("has no Content-Security-Policy header");
    const verdict = evaluateWorkerCsp("default-src 'none'; connect-src 'self' https://evil.example");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(describeWorkerCspFailure(verdict)).toBe(
        "has a Content-Security-Policy weaker than the plugin worker policy (connect-src allows https://evil.example)"
      );
    }
    const open = evaluateWorkerCsp("script-src 'self'");
    if (!open.ok) expect(describeWorkerCspFailure(open)).toMatch(/connect-src allows anything \(no such directive and no default-src\)/);
  });
});
