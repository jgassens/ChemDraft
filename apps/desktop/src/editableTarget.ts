const TEXT_ENTRY_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "time",
  "week"
]);

function isContentEditable(element: Element): boolean {
  if ("isContentEditable" in element) {
    return (element as HTMLElement).isContentEditable;
  }

  // jsdom does not currently implement isContentEditable. The nearest explicit
  // attribute determines whether an element is editable or inherits that state.
  for (let current: Element | null = element; current; current = current.parentElement) {
    const value = current.getAttribute("contenteditable");
    if (value !== null) return value.toLowerCase() !== "false";
  }
  return false;
}

/** Whether a context-menu target belongs to a text-entry field. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!element) return false;
  if (element.closest(".text-object-editor")) return true;

  const field = element.closest("textarea, input");
  if (field instanceof HTMLTextAreaElement) return !field.disabled;
  if (field instanceof HTMLInputElement) {
    return !field.disabled && TEXT_ENTRY_INPUT_TYPES.has(field.type.toLowerCase());
  }

  return isContentEditable(element);
}
