import { Fragment, type ReactNode } from "react";

/** Deliberately small, inert Markdown: React escapes all text, including HTML and link targets.
 * URLs are displayed for inspection/copying; this renderer never navigates or loads resources.
 */
export function PluginInlineMarkdown({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const tokens = /\\([\\`*\[\]])|`([^`\n]+)`|\*\*([^*]+)\*\*|\*([^*\n]+)\*|\[([^\]\n]+)\]\(([^\s)]+)\)/g;
  let end = 0;
  for (const match of text.matchAll(tokens)) {
    parts.push(text.slice(end, match.index));
    const [, escaped, code, bold, italic, label, url] = match;
    parts.push(<Fragment key={match.index}>{escaped !== undefined ? escaped
      : code !== undefined ? <code>{code}</code>
      : bold !== undefined ? <strong>{bold}</strong>
      : italic !== undefined ? <em>{italic}</em>
      : `${label} (${url})`}</Fragment>);
    end = match.index + match[0].length;
  }
  parts.push(text.slice(end));
  return <>{parts}</>;
}
