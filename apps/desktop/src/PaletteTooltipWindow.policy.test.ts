import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./App.css", import.meta.url), "utf8");
const native = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

function cssRule(selector: string, first = false): string {
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]+)\}/g)];
  const rule = (first ? rules : rules.reverse())
    .find((match) => match[1]!.split(",").some((entry) => entry.trim() === selector));
  expect(rule, selector).toBeDefined();
  return rule![2]!;
}

function nativeFunction(name: string): string {
  const start = native.indexOf(`fn ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return native.slice(start, native.indexOf("\n}\n", start) + 2);
}

describe("native palette tooltip suppression", () => {
  // These checks pin the native wiring; the Rust unit test exercises visibility transitions.
  // Both platforms must use the guard before reaching their separate reveal implementations.
  it("checks actual popover visibility before positioning or showing a delayed tooltip", () => {
    const show = nativeFunction("show_toolset_tooltip_window");
    const guard = show.indexOf("toolset_tooltip_suppressed(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(show.indexOf("set_window_global_logical_position"));
    expect(guard).toBeLessThan(show.indexOf('#[cfg(target_os = "macos")]'));
    expect(show.slice(guard, show.indexOf("let Some(window)"))).toContain("return Ok(())");
    expect(show).toContain("app.webview_windows()");
    expect(show).toContain("window.is_visible().unwrap_or(false)");
    // Querying every window's visibility on each tooltip show slowed toolbar clicks;
    // filter first so only popover windows are queried.
    const labelFilter = show.indexOf('.filter(|(label, _)| label.starts_with("toolset-popover-"))');
    expect(labelFilter).toBeGreaterThan(-1);
    expect(labelFilter).toBeLessThan(show.indexOf("is_visible("));
  });

  it("hides the existing tooltip before either platform reveals a popover", () => {
    const show = nativeFunction("show_toolset_popover_window");
    const hide = show.indexOf("hide_toolset_tooltip_window(");
    expect(hide).toBeGreaterThan(-1);
    expect(show).toContain("let _ = hide_toolset_tooltip_window(window.app_handle().clone());");
    expect(hide).toBeLessThan(show.indexOf('#[cfg(target_os = "macos")]'));
    expect(show.slice(0, hide)).not.toContain("window.show()");
  });
});

it("gives inspector select menus light opaque options without restyling closed controls", () => {
  expect(cssRule(".molecule-inspector-field select").trim()).toBe("color-scheme: light;");
  const options = cssRule(".molecule-inspector-field select option");
  expect(options).toBe(cssRule(".toolbar-select option"));
  expect(options).toContain("background-color: var(--cd-bg-control);");
  expect(options).toContain("color: var(--cd-text-primary);");
  const closed = cssRule(".molecule-inspector-field input");
  expect(closed).toContain("background: var(--cd-bg);");
  expect(closed).toContain("border: 1px solid var(--cd-border);");
  expect(closed).toContain("color: var(--cd-text);");
});

it("uses the light toolbar theme for native select menus, including their opaque options", () => {
  expect(cssRule(".toolbar-select")).toContain("color-scheme: light;");
  expect(cssRule(".toolbar-select", true)).toContain("var(--cd-bg-control)");
  expect(cssRule(".toolbar-select", true)).toContain("color: var(--cd-text-primary);");
  const options = cssRule(".toolbar-select option");
  expect(options).toContain("background-color: var(--cd-bg-control);");
  expect(options).toContain("color: var(--cd-text-primary);");
  expect(cssRule(":root")).toContain("--cd-bg-control: #ffffff;");
});

it("covers every dialog and panel select with the shared light menu rules", () => {
  const selectors = [".native-dialog-panel-select", ".lf-select"];
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]+)\}/g)];
  const sharedRule = rules.find((match) =>
    match[1]!.split(",").some((entry) => entry.trim() === ".toolbar-select")
    && match[2]!.trim() === "color-scheme: light;"
  );
  const optionRule = rules.find((match) =>
    match[1]!.split(",").some((entry) => entry.trim() === ".toolbar-select option")
  );
  expect(sharedRule).toBeDefined();
  expect(optionRule).toBeDefined();
  const sharedSelectors = sharedRule![1]!.split(",").map((entry) => entry.trim());
  const optionSelectors = optionRule![1]!.split(",").map((entry) => entry.trim());
  expect(sharedSelectors).toContain(".molecule-inspector-field select");
  expect(optionSelectors).toContain(".molecule-inspector-field select option");
  for (const selector of selectors) {
    expect(sharedSelectors).toContain(selector);
    expect(optionSelectors).toContain(`${selector} option`);
  }

  const sources = [
    ["dialogs/ExportForm.tsx", "native-dialog-panel-select"],
    ["dialogs/PageSizeForm.tsx", "native-dialog-panel-select"],
    ["dialogs/InsertTableForm.tsx", "native-dialog-panel-select"],
    ["analysis/MolecularInspectorPane.tsx", "native-dialog-panel-select"],
    ["plugins/PluginReportRenderer.tsx", "native-dialog-panel-select"],
    ["plugins/LinkedFigureView.tsx", "lf-select"],
  ];
  for (const [path, className] of sources) {
    const source = readFileSync(new URL(`./${path}`, import.meta.url), "utf8");
    const selects = [...source.matchAll(/<select\b([^>]*?)>/g)];
    expect(selects.length, path).toBeGreaterThan(0);
    for (const select of selects) {
      expect(select[1], path).toContain(`className="${className}"`);
    }
  }
});

it("requires every native select in desktop source to use a shared readable menu rule", () => {
  const directClasses = ["toolbar-select", "native-dialog-panel-select", "lf-select"];
  for (const className of directClasses) {
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]+)\}/g)];
    expect(rules.some(rule => rule[1]!.split(",").some(selector => selector.trim() === `.${className}`)
      && rule[2]!.includes("color-scheme: light;")), className).toBe(true);
    expect(cssRule(`.${className} option`)).toBe(cssRule(".toolbar-select option"));
  }
  function sources(directory: URL): URL[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
      return entry.isDirectory() ? sources(path)
        : /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
    });
  }
  const uncovered: string[] = [];
  let count = 0;
  for (const path of sources(new URL("./", import.meta.url))) {
    const source = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function classes(opening: ts.JsxOpeningLikeElement): string[] {
      const attribute = opening.attributes.properties.find((attr): attr is ts.JsxAttribute => ts.isJsxAttribute(attr) && attr.name.getText(source) === "className");
      const value = attribute?.initializer;
      if (value && ts.isStringLiteral(value)) return value.text.split(/\s+/);
      if (value && ts.isJsxExpression(value) && value.expression && ts.isTemplateExpression(value.expression)) {
        // Only complete classes before the first interpolation are guaranteed on every render.
        return value.expression.head.text.split(/\s+/).slice(0, -1);
      }
      return [];
    }
    function visit(node: ts.Node, inherited = false) {
      const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : undefined;
      const own = opening ? classes(opening) : [];
      const inspector = inherited || own.includes("molecule-inspector-field");
      if (opening?.tagName.getText(source) === "select") {
        count += 1;
        if (!inspector && !directClasses.some(className => own.includes(className))) {
          const line = source.getLineAndCharacterOfPosition(opening.getStart(source)).line + 1;
          uncovered.push(`${path.pathname}:${line}`);
        }
      }
      ts.forEachChild(node, child => visit(child, inspector));
    }
    visit(source);
  }
  expect(count).toBeGreaterThan(30);
  expect(uncovered, "Add a shared readable-menu class to these selects").toEqual([]);
});

it("forbids native title tooltips on Art palette controls", () => {
  const text = readFileSync(new URL("./ToolPalette.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("ToolPalette.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const art = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "ArtToolbarStyleControls");
  expect(art).toBeDefined();
  const nativeTitles: string[] = [];
  function visit(node: ts.Node) {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && /^[a-z]/.test(node.tagName.getText(source))) {
      for (const attr of node.attributes.properties) {
        if (ts.isJsxAttribute(attr) && attr.name.getText(source) === "title") nativeTitles.push(attr.getText(source));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(art!);
  expect(nativeTitles).toEqual([]);
  expect(art!.getText(source)).toContain("<PaletteControlTooltip tooltip=");
});
