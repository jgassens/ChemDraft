import { DocumentStyleScale, FigureStyles, type FigureStyle } from "@chemdraft/layout-engine";
import { numericOption, stringOption, type ParsedOptions } from "./args";
import { CliUsageError } from "./output";
export { FigureStyles } from "@chemdraft/layout-engine";

export interface FigureStyleOptions { style?: FigureStyle; dpi?: number }
export const figureStyleOptions = {
  "--style": { kind: "value" }, "--dpi": { kind: "value" }
} as const;
export const figureStyleHelp = `  --style fit|document            Fit (default) or fixed physical document style
  --dpi <n>                       Document PNG resolution, 72–1200 (default 300)
Document style uses a fixed 4 pt margin; --width, --bond-length and --padding conflict.`;

export function parseFigureStyle(parsed: ParsedOptions): Required<FigureStyleOptions> {
  const style = stringOption(parsed, "--style") ?? "fit";
  if (!FigureStyles.includes(style as FigureStyle)) throw new CliUsageError("--style must be fit or document.");
  if (style === "document") {
    for (const flag of ["--width", "--bond-length", "--padding"]) {
      if (parsed.options[flag] !== undefined) throw new CliUsageError(`${flag} conflicts with --style document.`);
    }
  } else if (parsed.options["--dpi"] !== undefined) throw new CliUsageError("--dpi is only valid with --style document.");
  const value = stringOption(parsed, "--dpi");
  const dpi = value === undefined ? DocumentStyleScale.defaultDpi : numericOption(value, "--dpi");
  if (dpi < DocumentStyleScale.minDpi || dpi > DocumentStyleScale.maxDpi) throw new CliUsageError("--dpi must be between 72 and 1200.");
  return { style: style as FigureStyle, dpi };
}

export function figureStyleResult(options: FigureStyleOptions, viewBox?: { width: number; height: number }, png = false) {
  const style = options.style ?? "fit";
  return { style, ...(style === "document" ? {
    ...(viewBox ? { widthPt: viewBox.width, heightPt: viewBox.height } : {}),
    ...(png ? { dpi: options.dpi ?? DocumentStyleScale.defaultDpi } : {})
  } : {}) };
}
