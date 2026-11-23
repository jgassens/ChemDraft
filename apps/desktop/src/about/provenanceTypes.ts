/** The operating systems ChemDraft ships on; the same names as ShortcutPlatform in @chemdraft/shortcut-engine. */
export type AboutPlatform = "macos" | "windows" | "linux";

export const ABOUT_PLATFORMS: readonly AboutPlatform[] = ["macos", "windows", "linux"];

/** "all" when the package ships on every platform, otherwise the platforms whose build contains it. */
export type PlatformTag = "all" | AboutPlatform[];

export interface AboutComponent {
  name: string;
  version: string;
  license: string;
  /** Copyright holders or authors from the package's own records, or ["see license"]. */
  holders: string[];
  purpose: string;
  sourceUrl: string;
  licenseText?: string;
  /** Platforms whose build ships this component. Absent means every platform. */
  platforms?: PlatformTag;
}

export interface AboutProvenance {
  components: AboutComponent[];
  licenseTexts: Record<string, string>;
}

export interface AboutContributor {
  name: string;
  handle?: string;
  contribution: string;
  sources: string[];
}

export interface AboutTesters {
  note: string;
  gatheredOn: string;
  source: string;
  method: string;
  handles: string[];
}
