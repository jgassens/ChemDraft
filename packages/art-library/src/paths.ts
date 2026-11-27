import { MAX_PATH_LENGTH } from "./limits";

const NON_ART_DIRECTORY = /^(evidence|proofs?)$/i;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)$/iu;

/** Checks the portable relative syntax of a discovered SVG with any extension casing. */
export function isLooseSvgPath(path: string): boolean {
  return path.length <= MAX_PATH_LENGTH &&
    !/[\\:\u0000-\u001f\u007f]/u.test(path) &&
    path.toLowerCase().endsWith(".svg") &&
    path.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
}

/** Returns an explanation for a source path excluded from discovery. */
export function importPathProblem(path: string): string | undefined {
  if (!isLooseSvgPath(path)) return "Not a safe SVG path";
  if (path.split("/").slice(0, -1).some(part => NON_ART_DIRECTORY.test(part))) return "Non-art folder";
  return undefined;
}

/** Checks a path segment against Windows filename restrictions, even on other platforms. */
export function isWindowsSafeSegment(segment: string): boolean {
  const basename = segment.split(".", 1)[0]!.replace(/ +$/, "");
  return !/[<>|?*"]|[. ]$/u.test(segment) && !WINDOWS_DEVICE.test(basename);
}

/** Folds case and strips trailing dots and spaces from each segment for Windows comparisons. */
export function windowsPathKey(path: string): string {
  return path.split("/").map(segment => segment.replace(/[. ]+$/u, "").toUpperCase()).join("/");
}
