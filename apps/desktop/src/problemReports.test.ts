import { describe, expect, it, vi } from "vitest";
import {
  briefLine,
  buildProblemReportMailto,
  describeError,
  isReportableError,
  openProblemReport,
  problemReportSubject,
  PROBLEM_REPORT_ADDRESS,
  type ProblemReport,
  watchForCrashes
} from "./problemReports";

const environment = { appVersion: "0.3.7", buildStamp: "test-stamp", platform: "macos" };

function decode(url: string) {
  const parsed = new URL(url);
  return {
    to: parsed.pathname,
    subject: parsed.searchParams.get("subject") ?? "",
    body: parsed.searchParams.get("body") ?? ""
  };
}

describe("problem reports", () => {
  it("addresses every report to the owner with the agreed subject prefixes", () => {
    expect(PROBLEM_REPORT_ADDRESS).toBe("jgassens@gmail.com");
    expect(problemReportSubject("bug", "ring tool misses")).toBe("ChemBUG: ring tool misses");
    expect(problemReportSubject("crash", "TypeError: x is undefined")).toBe("ChemCRASH: TypeError: x is undefined");

    const bug = decode(buildProblemReportMailto({ kind: "bug", brief: "ring tool misses", environment }));
    expect(bug.to).toBe("jgassens@gmail.com");
    expect(bug.subject).toBe("ChemBUG: ring tool misses");
    expect(bug.body).toContain("Version: 0.3.7");
    expect(bug.body).toContain("Build: test-stamp");

    const crash = decode(
      buildProblemReportMailto({ kind: "crash", brief: "boom", details: "Error: boom\n at x", environment })
    );
    expect(crash.subject).toBe("ChemCRASH: boom");
    expect(crash.body).toContain("Error: boom");
  });

  it("keeps the subject to one short line", () => {
    expect(briefLine("  two\n lines  ")).toBe("two lines");
    expect(briefLine("")).toBe("no details");
    expect(briefLine("x".repeat(200)).length).toBeLessThanOrEqual(70);
  });

  it("shortens long details so the link still opens", () => {
    const report: ProblemReport = { kind: "crash", brief: "big", details: "stack line\n".repeat(5000), environment };
    const url = buildProblemReportMailto(report);
    expect(url.length).toBeLessThanOrEqual(7500);
    expect(decode(url).subject).toBe("ChemCRASH: big");

    const windowsUrl = buildProblemReportMailto({ ...report, environment: { ...environment, platform: "windows" } });
    expect(windowsUrl.length).toBeLessThanOrEqual(2000);
    expect(decode(windowsUrl).body).toContain("Platform: windows");
  });

  it("produces only printable ASCII, which the native opener requires", () => {
    const url = buildProblemReportMailto({ kind: "bug", brief: "é ✓ ring", details: "π", environment });
    expect(/^[\x21-\x7e]+$/.test(url)).toBe(true);
  });

  it("opens through the native command on desktop and a plain link in the browser", async () => {
    const invoke = vi.fn(async () => undefined);
    const openLink = vi.fn();
    const report: ProblemReport = { kind: "bug", brief: "x", environment };
    await openProblemReport(report, { isDesktop: true, invoke, openLink });
    expect(invoke).toHaveBeenCalledWith("open_problem_report_email", { url: buildProblemReportMailto(report) });
    expect(openLink).not.toHaveBeenCalled();
    await openProblemReport(report, { isDesktop: false, invoke, openLink });
    expect(openLink).toHaveBeenCalledWith(buildProblemReportMailto(report));
  });

  it("describes thrown errors and other values", () => {
    const described = describeError(new TypeError("bad value"));
    expect(described.brief).toBe("bad value");
    expect(described.details).toContain("bad value");
    expect(describeError("plain text").brief).toBe("plain text");
    expect(describeError({ code: 3 }).details).toBe('{"code":3}');
  });

  it("ignores noise that is not a crash", () => {
    expect(isReportableError("ResizeObserver loop completed with undelivered notifications.")).toBe(false);
    expect(isReportableError("Script error.")).toBe(false);
    expect(isReportableError("")).toBe(false);
    expect(isReportableError("TypeError: x is undefined")).toBe(true);
  });

  it("offers a crash report once per session, for real exceptions only", () => {
    const target = new EventTarget();
    const onCrash = vi.fn();
    const stop = watchForCrashes({ onCrash, target: target as unknown as Window });

    const rejection = (reason: unknown) => Object.assign(new Event("unhandledrejection"), { reason });
    target.dispatchEvent(rejection("cancelled"));
    expect(onCrash).not.toHaveBeenCalled();

    const first = new Error("first");
    target.dispatchEvent(rejection(first));
    target.dispatchEvent(Object.assign(new Event("error"), { error: new Error("second"), message: "second" }));
    expect(onCrash).toHaveBeenCalledTimes(1);
    expect(onCrash).toHaveBeenCalledWith(first);

    stop();
  });
});
