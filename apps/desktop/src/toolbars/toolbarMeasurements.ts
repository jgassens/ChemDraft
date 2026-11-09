/** Read the same padding and borders that the rendered group uses, on its length axis. */
export function toolbarAxisInsets(style: CSSStyleDeclaration, orientation: "horizontal" | "vertical") {
  const px = (value: string) => Number.parseFloat(value) || 0;
  return orientation === "horizontal"
    ? { start: px(style.paddingLeft) + px(style.borderLeftWidth), end: px(style.paddingRight) + px(style.borderRightWidth) }
    : { start: px(style.paddingTop) + px(style.borderTopWidth), end: px(style.paddingBottom) + px(style.borderBottomWidth) };
}
