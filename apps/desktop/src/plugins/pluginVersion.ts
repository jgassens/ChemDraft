/** Strict Semantic Version comparison for host-managed plugin updates. */

interface ParsedPluginVersion {
  core: readonly [string, string, string];
  prerelease: readonly string[];
}

/** Parse and normalize a `v1.2.3` GitHub release tag. */
export function pluginVersionFromReleaseTag(tag: string): string {
  if (!tag.startsWith("v")) {
    throw new Error(`Plugin release tag "${tag}" must start with "v".`);
  }
  const version = tag.slice(1);
  parsePluginVersion(version);
  return version;
}

/** Whether a valid Semantic Version carries prerelease identifiers (build metadata does not count). */
export function isPluginPrereleaseVersion(version: string): boolean {
  return parsePluginVersion(version).prerelease.length > 0;
}

/** Returns a negative number, zero, or a positive number using Semantic Version precedence. */
export function comparePluginVersions(left: string, right: string): number {
  const parsedLeft = parsePluginVersion(left);
  const parsedRight = parsePluginVersion(right);

  for (const index of [0, 1, 2] as const) {
    const difference = compareNumericIdentifier(parsedLeft.core[index], parsedRight.core[index]);
    if (difference !== 0) return difference;
  }

  if (parsedLeft.prerelease.length === 0 && parsedRight.prerelease.length === 0) return 0;
  if (parsedLeft.prerelease.length === 0) return 1;
  if (parsedRight.prerelease.length === 0) return -1;

  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = parsedLeft.prerelease[index];
    const rightPart = parsedRight.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return compareNumericIdentifier(leftPart, rightPart);
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    // SemVer requires lexical ASCII ordering, not locale-sensitive collation.
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

/**
 * Compare a pair of numeric Semantic Version identifiers without converting them to IEEE-754
 * numbers. SemVer does not impose an integer-size limit, so digit count followed by ASCII order is
 * both exact and bounded by the already-validated input strings.
 */
function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function parsePluginVersion(version: string): ParsedPluginVersion {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version
    );
  if (!match) {
    throw new Error(`Plugin version "${version}" is not a valid Semantic Version.`);
  }
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) {
    throw new Error(`Plugin version "${version}" has a numeric prerelease identifier with a leading zero.`);
  }
  return {
    core: [match[1]!, match[2]!, match[3]!],
    prerelease
  };
}
