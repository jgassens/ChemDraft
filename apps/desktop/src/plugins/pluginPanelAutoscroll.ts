/** Whether a scroll container is close enough to its lower edge to follow new panel output. */
export function isScrolledToBottom(el: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">, tolerancePx = 24): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= tolerancePx;
}

/** A reader who scrolled away keeps their place; their own send may always reveal the reply. */
export function shouldAutoscroll({ wasAtBottom, ownSubmit }: { wasAtBottom: boolean; ownSubmit: boolean }): boolean {
  return wasAtBottom || ownSubmit;
}
