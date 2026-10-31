const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
export const MAX_SPECTRUM_SVG_BYTES = 20 * 1024 * 1024;
export const MAX_SPECTRUM_SVG_NODES = 50000;
export const MAX_SPECTRUM_SVG_DEPTH = 16;

// Fixed colors travel with the standalone figure instead of the app's CSS variables.
export const STANDALONE_SPECTRUM_STYLE = [
  ".lf-axis,.lf-tick{stroke:#8a8f98;stroke-width:1;fill:none}",
  ".lf-tick-label,.lf-axis-caption{fill:#5b6068;font:11px system-ui,sans-serif}",
  ".lf-curve{fill:none;stroke:#2f7d6f;stroke-width:1.25;stroke-linejoin:round}",
  ".lf-curve.is-active{stroke:#1f5a4f}",
  ".lf-curve.is-estimated{stroke:#8a8f98;opacity:.45;stroke-dasharray:2 2}",
  ".lf-curve.is-alternative{stroke:#b5651d;opacity:.72;stroke-dasharray:5 3}",
  ".lf-peak-label{fill:#2f7d6f;font:12px system-ui,sans-serif;text-anchor:middle}",
  ".lf-peak-label.is-estimated{fill:#8a8f98;font-style:italic}",
  ".lf-peak-label.is-alternative{fill:#b5651d;font-style:italic}",
  ".lf-spectrum-note{fill:#5b6068;font:9.5px system-ui,sans-serif}",
  ".lf-hit{fill:transparent;stroke:none}"
].join("");

const attributes: Readonly<Record<string, readonly string[]>> = {
  svg: ["xmlns", "class", "viewBox", "width", "height", "aria-label", "data-observe-frequency-mhz",
    "data-comparison-mode", "data-primary-method", "data-alternative-method"],
  style: [],
  rect: ["class", "x", "y", "width", "height", "fill", "pointer-events"],
  line: ["class", "x1", "y1", "x2", "y2", "stroke", "stroke-width", "pointer-events"],
  text: ["class", "x", "y", "style", "text-anchor"],
  g: ["class", "data-peak-id", "data-variant", "data-line-count", "tabindex", "aria-label"],
  path: ["class", "d"],
  title: []
};
const classes = new Set([
  "lf-spectrum", "lf-axis", "lf-tick", "lf-tick-label", "lf-axis-caption", "lf-curve", "lf-peak",
  "lf-peak-label", "lf-spectrum-note", "lf-hit", "lf-label-leader", "lf-label-background",
  "is-active", "is-estimated", "is-alternative"
]);
const numberPattern = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
const numeric = new RegExp(`^${numberPattern}$`);
const pathPattern = new RegExp(`^(?:[ML]\\s*${numberPattern}[ ,]+${numberPattern}\\s*)+$`);

function invalid(): never {
  throw new Error("Invalid spectrum SVG.");
}

/** Validate without rewriting: the figure's bytes, labels and styling must travel unchanged. */
export function sanitizeSpectrumSvg(markup: string): string {
  if (typeof markup !== "string" || !markup.length || markup.length > MAX_SPECTRUM_SVG_BYTES) invalid();
  let bytes = 0;
  for (const character of markup) {
    const code = character.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > MAX_SPECTRUM_SVG_BYTES) invalid();
  }
  const source = markup.replace(/^<\?xml version="1\.0" encoding="UTF-8"\?>\s*/, "");
  if (/<!|<\?/.test(source)) invalid();
  // Bound work before constructing a DOM, including deeply nested or malformed XML.
  let depth = 0;
  let elements = 0;
  for (let offset = 0; offset < source.length; offset += 1) {
    if (source[offset] !== "<") continue;
    const start = offset;
    let quote = "";
    for (offset += 1; offset < source.length; offset += 1) {
      const character = source[offset];
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
    }
    if (offset === source.length) invalid();
    if (source[start + 1] === "/") depth -= 1;
    else {
      elements += 1;
      depth += 1;
      if (elements > MAX_SPECTRUM_SVG_NODES || depth > MAX_SPECTRUM_SVG_DEPTH) invalid();
      if (source[offset - 1] === "/") depth -= 1;
    }
    if (depth < 0) invalid();
  }
  if (depth !== 0) invalid();
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  if (parsed.getElementsByTagName("parsererror").length || parsed.documentElement.tagName !== "svg") invalid();
  let nodes = 0;
  let pathBytes = 0;
  const pending: Node[] = [parsed];
  while (pending.length) {
    const node = pending.pop()!;
    if (++nodes > MAX_SPECTRUM_SVG_NODES) invalid();
    if (node.nodeType === 1) {
      const element = node as Element;
      const allowed = attributes[element.tagName];
      if (!Object.hasOwn(attributes, element.tagName) ||
          (element.namespaceURI !== null && element.namespaceURI !== SVG_NAMESPACE) ||
          (element.tagName === "svg" && element !== parsed.documentElement)) invalid();
      for (const attribute of Array.from(element.attributes)) {
        const { name, value } = attribute;
        if (!allowed.includes(name)) invalid();
        if (name === "xmlns" && value !== SVG_NAMESPACE) invalid();
        if (name === "class" && value.split(/\s+/).some((token) => !classes.has(token))) invalid();
        if (name === "style" && !/^font-size:\s*(?:11|13)px;?$/.test(value)) invalid();
        if (name === "fill" && !["#ffffff", "#fff"].includes(value)) invalid();
        if (name === "stroke" && value !== "#8a8f98") invalid();
        if (name === "pointer-events" && value !== "none") invalid();
        if (name === "text-anchor" && value !== "middle") invalid();
        if (name === "tabindex" && value !== "0") invalid();
        if (name === "viewBox") {
          const values = value.trim().split(/[\s,]+/);
          if (values.length !== 4 || values.some((part) => !finiteNumber(part)) || Number(values[2]) <= 0 || Number(values[3]) <= 0) invalid();
        }
        if (["x", "y", "x1", "y1", "x2", "y2", "width", "height", "stroke-width", "data-observe-frequency-mhz", "data-line-count"].includes(name) &&
            !(element.tagName === "rect" && ["width", "height"].includes(name) && value === "100%") && !finiteNumber(value)) invalid();
        if (name === "d") {
          pathBytes += value.length;
          if (value.length > 1024 * 1024 || pathBytes > 4 * 1024 * 1024 || !pathPattern.test(value) ||
              (value.match(new RegExp(numberPattern, "g")) ?? []).some((part) => !finiteNumber(part))) invalid();
        }
      }
      if (element.tagName === "style" && element.textContent !== STANDALONE_SPECTRUM_STYLE) invalid();
    } else if (node.nodeType === 3) {
      if (!["text", "title", "style"].includes(node.parentNode?.nodeName ?? "") && node.textContent?.trim()) invalid();
    } else if (node.nodeType !== 9) invalid();
    for (let child = node.lastChild; child; child = child.previousSibling) pending.push(child);
  }
  return markup;
}

function finiteNumber(value: string): boolean {
  return numeric.test(value) && Number.isFinite(Number(value)) && Math.abs(Number(value)) <= 1000000;
}
