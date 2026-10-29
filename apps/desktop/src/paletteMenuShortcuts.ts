import type { ShortcutRegistry } from "@chemdraft/shortcut-engine";

/** Resolve app actions through the palette's actual bindings, bypassing only the registry's
 * text-target filter. Editing, clipboard and drawing commands never use this route. */
export function paletteMenuShortcut(event: KeyboardEvent, registry: ShortcutRegistry): string | undefined {
  if (event.defaultPrevented || event.isComposing || !(event.ctrlKey || event.metaKey || event.altKey)) return;
  const command = registry.resolve({
    key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
    altKey: event.altKey, shiftKey: event.shiftKey, repeat: event.repeat
  });
  return command && /^(document|export|view|app)\./.test(command) ? command : undefined;
}
