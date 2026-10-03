/**
 * Bug and crash reports, sent as an email the user reviews in their own mail client.
 *
 * Nothing leaves the computer on its own: every report is a `mailto:` draft the user can edit or
 * discard. On the desktop build the native side opens it (`open_problem_report_email`, which only
 * accepts drafts to {@link PROBLEM_REPORT_ADDRESS}); the browser build follows the link itself.
 *
 * Subjects follow the owner's inbox filter: `ChemBUG: <brief>` for a report the user starts from
 * Help ▸ Report a Bug…, `ChemCRASH: <brief>` for an error ChemDraft caught.
 */

export const PROBLEM_REPORT_ADDRESS = "jgassens@gmail.com";
export const REPORT_BUG_COMMAND_ID = "help.reportBug";

export type ProblemReportKind = "bug" | "crash";

export interface ProblemReportEnvironment {
  appVersion: string;
  buildStamp: string;
  platform: string;
  userAgent?: string;
}

export interface ProblemReport {
  kind: ProblemReportKind;
  /** A few words for the subject line; trimmed to one short line. */
  brief: string;
  /** Technical details (error message, stack, crash note). Shortened to fit a mail link. */
  details?: string;
  environment: ProblemReportEnvironment;
}

const SUBJECT_PREFIX: Readonly<Record<ProblemReportKind, string>> = {
  bug: "ChemBUG",
  crash: "ChemCRASH"
};

const MAX_BRIEF_CHARS = 70;
/** Mail clients reject very long `mailto:` links; the native side refuses anything over 8000. */
const MAX_MAILTO_CHARS = 7500;

/** Collapses text to one short line suitable for a subject. */
export function briefLine(text: string, fallback = "no details"): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) {
    return fallback;
  }
  return line.length > MAX_BRIEF_CHARS ? `${line.slice(0, MAX_BRIEF_CHARS - 1).trimEnd()}…` : line;
}

export function problemReportSubject(kind: ProblemReportKind, brief: string): string {
  return `${SUBJECT_PREFIX[kind]}: ${briefLine(brief)}`;
}

function reportBody(report: ProblemReport, details: string | undefined): string {
  const { environment } = report;
  const intro =
    report.kind === "bug"
      ? [
          "What happened, and what did you expect instead?",
          "",
          "",
          "Steps to make it happen again (if you know them):",
          "1. ",
          "",
          "Please replace the subject's brief text with a few words about the problem.",
          "Attaching the drawing or a screenshot helps a lot."
        ]
      : [
          "ChemDraft ran into an error. Anything you were doing just before it helps:",
          "",
          ""
        ];
  const lines = [
    ...intro,
    "",
    "--- ChemDraft details (please keep) ---",
    `Version: ${environment.appVersion}`,
    `Build: ${environment.buildStamp}`,
    `Platform: ${environment.platform}`
  ];
  if (environment.userAgent) {
    lines.push(`Browser engine: ${environment.userAgent}`);
  }
  if (details) {
    lines.push("", "Error:", details);
  }
  return lines.join("\r\n");
}

/** Builds the `mailto:` draft, shortening the details until the link fits every mail client. */
export function buildProblemReportMailto(report: ProblemReport): string {
  const subject = encodeURIComponent(problemReportSubject(report.kind, report.brief));
  const make = (details: string | undefined) =>
    `mailto:${PROBLEM_REPORT_ADDRESS}?subject=${subject}&body=${encodeURIComponent(reportBody(report, details))}`;
  let details = report.details?.trim() || undefined;
  let url = make(details);
  while (url.length > MAX_MAILTO_CHARS && details) {
    const keep = Math.floor(details.length * 0.75);
    details = keep > 40 ? `${details.slice(0, keep).trimEnd()}\n… (shortened)` : undefined;
    url = make(details);
  }
  return url;
}

/** Turns whatever was thrown into a brief line and a details block. */
export function describeError(error: unknown): { brief: string; details: string } {
  if (error instanceof Error) {
    const head = `${error.name}: ${error.message}`;
    const stack = error.stack?.includes(error.message) ? error.stack : `${head}\n${error.stack ?? ""}`;
    return { brief: briefLine(error.message || error.name), details: stack.trim() };
  }
  const text = typeof error === "string" ? error : safeStringify(error);
  return { brief: briefLine(text), details: text };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export interface ProblemReportDeps {
  isDesktop: boolean;
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  openLink(url: string): void;
}

/** Opens the drafted report in the user's mail client. */
export async function openProblemReport(report: ProblemReport, deps: ProblemReportDeps): Promise<void> {
  const url = buildProblemReportMailto(report);
  if (deps.isDesktop) {
    await deps.invoke("open_problem_report_email", { url });
    return;
  }
  deps.openLink(url);
}

/**
 * Errors not worth a crash report: the browser's own resize-loop warning, and errors thrown by
 * scripts from other origins, which arrive with no detail at all.
 */
export function isReportableError(message: string | undefined): boolean {
  const text = (message ?? "").trim();
  if (!text || text === "Script error." || text === "Script error") {
    return false;
  }
  return !/ResizeObserver loop/i.test(text);
}

export interface CrashWatchOptions {
  /** Called once per session, for the first reportable uncaught error. */
  onCrash(error: unknown): void;
  target?: Pick<Window, "addEventListener" | "removeEventListener">;
}

/** Watches for uncaught errors and unhandled promise failures. Returns the cleanup. */
export function watchForCrashes({ onCrash, target = window }: CrashWatchOptions): () => void {
  let reported = false;
  const report = (error: unknown, message: string | undefined) => {
    if (reported || !isReportableError(message)) {
      return;
    }
    reported = true;
    onCrash(error);
  };
  const handleError = (event: Event) => {
    const errorEvent = event as ErrorEvent;
    report(errorEvent.error ?? errorEvent.message, errorEvent.message || describeError(errorEvent.error).brief);
  };
  const handleRejection = (event: Event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    // Only real exceptions: a bare rejected value is usually a cancelled request, not a crash.
    if (reason instanceof Error) {
      report(reason, reason.message || reason.name);
    }
  };
  target.addEventListener("error", handleError);
  target.addEventListener("unhandledrejection", handleRejection);
  return () => {
    target.removeEventListener("error", handleError);
    target.removeEventListener("unhandledrejection", handleRejection);
  };
}

/** The real dependencies: the native opener on desktop, a plain link in the browser build. */
export function runtimeProblemReportDeps(isDesktop: boolean): ProblemReportDeps {
  return {
    isDesktop,
    invoke: async (command, args) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke(command, args);
    },
    openLink: (url) => {
      window.location.href = url;
    }
  };
}

/** Version, build and platform for the report footer. */
export async function currentReportEnvironment(
  isDesktop: boolean,
  buildStamp: string,
  platform: string
): Promise<ProblemReportEnvironment> {
  let appVersion = "browser build";
  if (isDesktop) {
    try {
      const { getVersion } = await import("@tauri-apps/api/app");
      appVersion = await getVersion();
    } catch {
      appVersion = "unknown";
    }
  }
  const userAgent = typeof navigator === "undefined" ? undefined : navigator.userAgent;
  return { appVersion, buildStamp, platform, userAgent };
}

/** Asks before drafting a crash report: a native dialog on desktop, `confirm` in the browser. */
export async function askToSendCrashReport(isDesktop: boolean, brief: string, earlierRun: boolean): Promise<boolean> {
  const text = earlierRun
    ? `ChemDraft closed unexpectedly last time (${brief}).\n\nWould you like to email a crash report? Your email program will open with the report so you can read it before sending.`
    : `ChemDraft ran into an error (${brief}).\n\nWould you like to email a crash report? Your email program will open with the report so you can read it before sending. Saving your work first is a good idea.`;
  if (isDesktop) {
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    return confirm(text, { title: "Send a crash report?", okLabel: "Email Report", cancelLabel: "Not Now", kind: "warning" });
  }
  return window.confirm(text);
}
