/** Shared lazy payload for SVG embedding and PDF registration. */
let fontModule: { default: string } | undefined;
let pending: Promise<{ default: string }> | undefined;

export function loadHandwritingFont(): Promise<{ default: string }> {
  return pending ??= import("./fonts/PatrickHand-Regular").then(module => {
    fontModule = module;
    return module;
  }).catch(error => {
    pending = undefined;
    throw error;
  });
}

export async function ensureHandwritingFontLoaded(): Promise<void> {
  await loadHandwritingFont();
}

export class HandwritingFontNotLoadedError extends Error {
  constructor() {
    super("Cannot export Sketch SVG: await ensureHandwritingFontLoaded() before calling exportDocumentToSvg().");
    this.name = "HandwritingFontNotLoadedError";
  }
}

/** The only embedded font CSS accepted at the PDF boundary; exact reviewed bytes. */
export function handwritingFontFaceCss(): string | undefined {
  return fontModule && `@font-face { font-family: 'Patrick Hand'; font-style: normal; font-weight: 400; src: url(data:font/ttf;base64,${fontModule.default}) format('truetype'); }`;
}

export function requireHandwritingFontFaceCss(): string {
  const css = handwritingFontFaceCss();
  if (!css) throw new HandwritingFontNotLoadedError();
  return css;
}
