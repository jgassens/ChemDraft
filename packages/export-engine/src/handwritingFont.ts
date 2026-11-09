import patrickHandFont from "./fonts/PatrickHand-Regular";

/** The only embedded font CSS accepted at the PDF boundary; exact reviewed bytes. */
export const patrickHandFontFaceCss = `@font-face { font-family: 'Patrick Hand'; font-style: normal; font-weight: 400; src: url(data:font/ttf;base64,${patrickHandFont}) format('truetype'); }`;
