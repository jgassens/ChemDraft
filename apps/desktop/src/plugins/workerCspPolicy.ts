/**
 * Decide whether a served `Content-Security-Policy` confines a plugin worker at least as tightly as
 * {@link INSTALLED_PLUGIN_WORKER_CSP}.
 *
 * A module worker takes its CSP from its own script response, not from the page that creates it. The
 * desktop app and the Vite dev server set that header themselves; a static host serving the browser
 * build sends only what it was configured to send. The preloaded-plugin loader therefore probes each
 * entry script and refuses to start the worker unless this check passes (fail closed).
 *
 * "At least as strict" is judged directive by directive, for every fetch directive a worker can use to
 * reach the network (fetch/XHR/WebSocket, `import()`/`importScripts`, nested workers, fonts, …): the
 * effective source list after CSP's fallback rules (`worker-src` → `child-src` → `script-src` →
 * `default-src`, and so on) must be a subset of the reference policy's effective list. A directive
 * that is absent with no `default-src` behind it allows everything, so it fails. Anything this parser
 * does not recognise as one of the reference's own source expressions (hosts, schemes other than
 * `blob:`, `*`, nonces, hashes, `'unsafe-eval'`, `'strict-dynamic'`) fails too: a policy that is
 * equivalent but spelled differently is refused rather than reasoned about.
 */
import { INSTALLED_PLUGIN_WORKER_CSP } from "./installedPluginAssetPath";

/** Fallback chain for each fetch directive a worker can use, most specific first. */
const FETCH_DIRECTIVE_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  "connect-src": ["connect-src", "default-src"],
  "script-src": ["script-src", "default-src"],
  "script-src-elem": ["script-src-elem", "script-src", "default-src"],
  "worker-src": ["worker-src", "child-src", "script-src", "default-src"],
  "child-src": ["child-src", "default-src"],
  "frame-src": ["frame-src", "child-src", "default-src"],
  "font-src": ["font-src", "default-src"],
  "img-src": ["img-src", "default-src"],
  "media-src": ["media-src", "default-src"],
  "object-src": ["object-src", "default-src"],
  "manifest-src": ["manifest-src", "default-src"],
  "style-src": ["style-src", "default-src"],
  "style-src-elem": ["style-src-elem", "style-src", "default-src"]
};

type Policy = ReadonlyMap<string, readonly string[]>;

/** Parse one serialized policy. Per CSP, a repeated directive is ignored after its first occurrence. */
function parsePolicy(serialized: string): Policy {
  const directives = new Map<string, readonly string[]>();
  for (const part of serialized.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const name = tokens[0].toLowerCase();
    if (directives.has(name)) continue;
    directives.set(
      name,
      tokens.slice(1).map((token) => (token.startsWith("'") || token.endsWith(":") ? token.toLowerCase() : token))
    );
  }
  return directives;
}

/** Effective sources for a directive, or `undefined` when the policy leaves it unrestricted. */
function effectiveSources(policy: Policy, directive: string): readonly string[] | undefined {
  for (const name of FETCH_DIRECTIVE_FALLBACKS[directive] ?? [directive, "default-src"]) {
    const sources = policy.get(name);
    if (sources !== undefined) {
      // `'none'` matches nothing; any other expression beside it is what actually applies.
      return sources.filter((source) => source !== "'none'");
    }
  }
  return undefined;
}

const REFERENCE_POLICY = parsePolicy(INSTALLED_PLUGIN_WORKER_CSP);

export type WorkerCspVerdict =
  | { ok: true }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "weaker"; directive: string; allowed: readonly string[] | "unrestricted" };

/**
 * Check a `Content-Security-Policy` header value (as `Headers.get` returns it: several policies joined
 * by `", "`, every one of which a browser enforces). For each directive it is enough that one policy is
 * strict enough, because the browser allows only what every policy allows.
 */
export function evaluateWorkerCsp(header: string | null | undefined): WorkerCspVerdict {
  if (header === null || header === undefined || header.trim() === "") return { ok: false, reason: "missing" };
  const policies = header
    .split(",")
    .map((serialized) => serialized.trim())
    .filter(Boolean)
    .map(parsePolicy);
  for (const directive of Object.keys(FETCH_DIRECTIVE_FALLBACKS)) {
    const reference = new Set(effectiveSources(REFERENCE_POLICY, directive) ?? []);
    let firstAllowed: readonly string[] | "unrestricted" | undefined;
    const satisfied = policies.some((policy) => {
      const sources = effectiveSources(policy, directive);
      if (sources === undefined) {
        firstAllowed ??= "unrestricted";
        return false;
      }
      if (sources.every((source) => reference.has(source))) return true;
      firstAllowed ??= sources.filter((source) => !reference.has(source));
      return false;
    });
    if (!satisfied) return { ok: false, reason: "weaker", directive, allowed: firstAllowed ?? "unrestricted" };
  }
  return { ok: true };
}

/** A specific explanation of a failed verdict, for the status line and diagnostics. */
export function describeWorkerCspFailure(verdict: Exclude<WorkerCspVerdict, { ok: true }>): string {
  if (verdict.reason === "missing") return "has no Content-Security-Policy header";
  const allowed =
    verdict.allowed === "unrestricted" ? "anything (no such directive and no default-src)" : verdict.allowed.join(" ");
  return `has a Content-Security-Policy weaker than the plugin worker policy (${verdict.directive} allows ${allowed})`;
}
