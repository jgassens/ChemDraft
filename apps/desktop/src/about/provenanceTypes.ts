export interface AboutComponent {
  name: string;
  version: string;
  license: string;
  /** Copyright holders or authors from the package's own records, or ["see license"]. */
  holders: string[];
  purpose: string;
  sourceUrl: string;
  licenseText?: string;
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
