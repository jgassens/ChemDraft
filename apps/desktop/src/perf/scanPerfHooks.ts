import ts from "typescript";

/** Static backstop, independent of the action/fault matrix. No app file inventory. */
export function scanPerfHooks(file: string, text: string) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hooks: string[] = [], errors: string[] = [];
  const probes = new Set(["perfProbe"]), wrappers = new Set(["perfHook"]);
  const functions = new Set(["nativeWindowOpening", "nativeWindowShown", "sendPerfCompletion", "perfSurfaceReady",
    "perfToggleResolved", "perfCanvasReady", "onPerfStarted", "startPerfProbe", "startMainWindowPerfProbe", "perfProbeRequestedFromWindow"]);
  const tainted = new Set<string>();
  const unwrap = (node: ts.Expression): ts.Expression => ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)
    || ts.isAsExpression(node) ? unwrap(node.expression) : node;
  const isProbe = (node: ts.Expression): boolean => {
    node = unwrap(node);
    return ts.isIdentifier(node) ? probes.has(node.text)
      : ts.isPropertyAccessExpression(node) && probes.has(node.name.text);
  };
  const isFunction = (node: ts.Expression, names: Set<string>): boolean => {
    node = unwrap(node);
    return ts.isIdentifier(node) ? names.has(node.text)
      : ts.isPropertyAccessExpression(node) && names.has(node.name.text);
  };
  const isHook = (node: ts.CallExpression) => isFunction(node.expression, functions)
    || (ts.isPropertyAccessExpression(unwrap(node.expression)) && isProbe((unwrap(node.expression) as ts.PropertyAccessExpression).expression))
    || (ts.isElementAccessExpression(unwrap(node.expression)) && isProbe((unwrap(node.expression) as ts.ElementAccessExpression).expression));
  const isWrapper = (node: ts.CallExpression) => isFunction(node.expression, wrappers);
  const diagnosticResult = (expression: ts.Expression): boolean => {
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) return tainted.has(node.text);
    if (ts.isAwaitExpression(node)) return diagnosticResult(node.expression);
    if (ts.isArrayLiteralExpression(node)) return node.elements.some(diagnosticResult);
    if (!ts.isCallExpression(node)) return false;
    if (isHook(node) || isWrapper(node)) return true;
    if (ts.isPropertyAccessExpression(node.expression) && ["then", "catch", "finally"].includes(node.expression.name.text)
      && diagnosticResult(node.expression.expression)) return true;
    // Awaiting Promise.resolve/all(probeResult) delays the action.
    return /^Promise\.(resolve|all|allSettled|race|any)$/.test(node.expression.getText(source))
      && node.arguments.some(diagnosticResult);
  };
  const walk = (node: ts.Node, visit: (node: ts.Node) => void) => { visit(node); ts.forEachChild(node, child => walk(child, visit)); };
  // Resolve aliases before checking calls, including destructured members of the probe object.
  let previousSize = -1;
  while (previousSize !== probes.size + wrappers.size + functions.size + tainted.size) {
    previousSize = probes.size + wrappers.size + functions.size + tainted.size;
    walk(source, node => {
      if (ts.isImportSpecifier(node)) {
        const original = node.propertyName?.text ?? node.name.text;
        if (probes.has(original)) probes.add(node.name.text);
        if (wrappers.has(original)) wrappers.add(node.name.text);
        if (functions.has(original)) functions.add(node.name.text);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(node.left) && diagnosticResult(node.right)) tainted.add(node.left.text);
      if (!ts.isVariableDeclaration(node) || !node.initializer) return;
      if (ts.isIdentifier(node.name)) {
        if (isProbe(node.initializer)) probes.add(node.name.text);
        if (isFunction(node.initializer, functions)) functions.add(node.name.text);
        const initializer = unwrap(node.initializer);
        if (ts.isPropertyAccessExpression(initializer) && isProbe(initializer.expression)) functions.add(node.name.text);
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const original = element.propertyName?.getText(source) ?? element.name.text;
          if (isProbe(node.initializer) || functions.has(original)) functions.add(element.name.text);
          if (probes.has(original)) probes.add(element.name.text);
        }
      }
      if (ts.isIdentifier(node.name)) {
        if (diagnosticResult(node.initializer)) tainted.add(node.name.text);
      }
    });
  }
  const location = (node: ts.Node) => `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  walk(source, node => {
    if (ts.isAwaitExpression(node)) {
      if (diagnosticResult(node.expression)) errors.push(`${location(node)}: action awaits probe result`);
    }
    if (!ts.isCallExpression(node) || !isHook(node)) return;
    hooks.push(`${location(node)}: ${node.expression.getText(source)}`);
    // Initialization has an explicit try/catch. Teardown must run after perfHook disables itself.
    if (file.replaceAll("\\", "/").endsWith("/perf/runtime.ts")) {
      let owner: ts.Node | undefined = node.parent;
      let caught = false;
      while (owner && !ts.isFunctionDeclaration(owner)) {
        if (ts.isTryStatement(owner) && owner.catchClause) caught = true;
        owner = owner.parent;
      }
      const name = owner && ts.isFunctionDeclaration(owner) ? owner.name?.text : undefined;
      const call = node.expression.getText(source);
      if (name === "initializePerfProbe" && call === "perfProbeRequestedFromWindow") return;
      if (name === "reportPerfFailure" && caught && ["perfProbe?.stop", "perfProbeRequestedFromWindow"].includes(call)) return;
    }
    let parent: ts.Node | undefined = node.parent;
    let isolated = false;
    while (parent) {
      if (ts.isCallExpression(parent) && isWrapper(parent)) { isolated = true; break; }
      if (ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent) || ts.isConstructorDeclaration(parent)) break;
      if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent) || ts.isFunctionDeclaration(parent)) {
        const caller: ts.Node = parent.parent;
        // guard invokes synchronously; timers, listeners and promise callbacks do not.
        const guard = ts.isCallExpression(caller) && ts.isPropertyAccessExpression(caller.expression)
          && isProbe(caller.expression.expression) && caller.expression.name.text === "guard";
        if (!(ts.isCallExpression(caller) && isWrapper(caller)) && !guard) break;
      }
      parent = parent.parent;
    }
    if (!isolated) errors.push(`${location(node)}: unisolated probe call ${node.expression.getText(source)}`);
  });
  return { hooks, errors };
}
