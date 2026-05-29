export interface CompatibilityConversionWarning {
  code: string;
  message: string;
  sourceObjectId?: string;
}

export interface CdxCompatPlaceholder {
  status: "not-implemented";
  warnings: CompatibilityConversionWarning[];
}

export const cdxCompatPlaceholder: CdxCompatPlaceholder = {
  status: "not-implemented",
  warnings: []
};
