import { readSvgInfo, type GraphicObject } from "@chemdraft/chem-core";
import { clipRelation, intersectPaths, prepareClip, type PreparedClip } from "./clipping";
import {
  about, boxForPoints, compose, corners, determinant, identity, inverse, length, localPathData, maxScale,
  parseTransform, pathBounds, point, polygonPath, readViewBox, rotate, scale, transformPath, translate, viewportMatrix,
  validBounds, type Bounds, type Matrix, type Path, type Size
} from "./geometry";
import { readPaint } from "./gradients";
import {
  colorParser, defaultPresentation, elementChildren, graphicPaintStyle, href, inheritPresentation, inlineStyle, isPresentation, opacity,
  inheritedProperty, property, reference, strokeStyle, strokeWidth, transformedStrokeScale, type Declarations, type Presentation
} from "./presentation";
import {
  closeSubpaths, isLinearPath, isSimpleClosedPath, nonzeroPathForEvenOdd, primitiveGeometry, readShape,
  shapeAttributes, shapeBounds, type Shape
} from "./shapes";
import { hasTextChildren, readText, textAttributes } from "./text";
import {
  SVG_IMPORT_MAX_DEPTH, SVG_IMPORT_MAX_ELEMENTS, SVG_IMPORT_MAX_EXPANDED_ELEMENTS, SVG_IMPORT_MAX_OBJECTS,
  SVG_IMPORT_MAX_PATH_CHARS, SVG_IMPORT_MAX_REFERENCE_DEPTH, SVG_IMPORT_MAX_SOURCE_CHARS, SvgImportError,
  type ReportLoss, type SvgImportErrorCode, type SvgImportObject, type SvgImportOptions, type SvgImportReportCode,
  type SvgImportReportEntry, type SvgImportResult
} from "./types";

export * from "./types";

const svgNamespace = "http://www.w3.org/2000/svg";
const definitions = new Set(["defs", "symbol", "linearGradient", "radialGradient", "pattern", "clipPath", "mask",
  "filter", "marker", "title", "desc", "metadata"]);
const viewportAttributes = ["x", "y", "width", "height", "viewBox", "preserveAspectRatio"];
const commonAttributes = new Set(["id", "class", "style", "role", "version", "xmlns"]);
const useAttributes = ["href", "xlink:href", "x", "y", "width", "height"];
const groupTags = new Set(["g", "svg", "symbol", "a"]);
const ignoredClipPaint = new Set(["fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "opacity", "color"]);

type Viewport = { inverseMatrix: Matrix; box: Bounds; clip: PreparedClip };
type Clip = { owner: Element; element: Element; matrix: Matrix; viewport: Size };
type Context = {
  matrix: Matrix;
  style: Presentation;
  viewport: Size;
  viewports: readonly Viewport[];
  clips: readonly Clip[];
  opacity: number;
  localOpacity: number;
  references: readonly Element[];
};

/** Converts the sanitized payload of an SVG picture. The caller supplies XML parsing
 * and ids and owns any eventual document mutation. */
export function convertSvgToShapes(svgSource: string, options: SvgImportOptions): SvgImportResult {
  if (svgSource.length > SVG_IMPORT_MAX_SOURCE_CHARS) {
    failLimit("source_limit", SVG_IMPORT_MAX_SOURCE_CHARS, "source characters");
  }
  const { frame, idFactory, domParser } = options;
  if (![frame.x, frame.y, frame.width, frame.height, frame.rotation, frame.x + frame.width, frame.y + frame.height].every(Number.isFinite)
    || frame.width <= 0 || frame.height <= 0) {
    throw new SvgImportError("invalid_frame", "SVG import needs a finite picture frame with positive width and height.");
  }
  const root = domParser.parseFromString(svgSource, "image/svg+xml").documentElement;
  if (!root || root.localName !== "svg" || root.namespaceURI !== svgNamespace) {
    throw new SvgImportError("invalid_svg", "SVG import needs a well-formed SVG document.");
  }
  const { byId, stylesheets } = indexSource(root);
  const canonicalColor = colorParser(root.ownerDocument);
  const objects: SvgImportObject[] = [];
  const preparedClips = new WeakMap<Clip, PreparedClip | undefined>();
  const entries = new Map<string, SvgImportReportEntry>();
  const reported = new WeakMap<Element, Set<string>>();
  const reportFor = (element: Element): ReportLoss => (code, detail) => {
    const key = code + "\u0000" + detail;
    let previous = reported.get(element);
    if (!previous) reported.set(element, previous = new Set());
    if (previous.has(key)) return;
    previous.add(key);
    const entry = entries.get(key);
    if (entry) entry.elementCount++;
    else entries.set(key, { code, detail, elementCount: 1 });
  };
  for (const stylesheet of stylesheets) reportFor(stylesheet)("svgImport.stylesheet_not_kept", "SVG stylesheet");

  let expanded = 0, processedPathChars = 0, outputPathChars = 0, drawables = 0;
  function countExpanded(count: number): void {
    expanded += count;
    if (expanded > SVG_IMPORT_MAX_EXPANDED_ELEMENTS) {
      failLimit("object_limit", SVG_IMPORT_MAX_EXPANDED_ELEMENTS, "expanded SVG elements");
    }
  }
  function addObject<T extends SvgImportObject>(object: T): T {
    if (objects.length >= SVG_IMPORT_MAX_OBJECTS) failLimit("object_limit", SVG_IMPORT_MAX_OBJECTS, "native objects");
    objects.push(object);
    if (object.type !== "group") drawables++;
    return object;
  }
  function encodePath(path: Path, bounds: Bounds): string {
    const data = localPathData(path, bounds);
    outputPathChars += data.length;
    if (outputPathChars > SVG_IMPORT_MAX_PATH_CHARS) failLimit("path_limit", SVG_IMPORT_MAX_PATH_CHARS, "native path-data characters");
    return data;
  }
  function sourceShape(element: Element, css: Declarations, viewport: Size, em: number): Shape | undefined {
    processedPathChars += (css.get("d") ?? element.getAttribute("d") ?? "").length
      + (css.get("points") ?? element.getAttribute("points") ?? "").length;
    if (processedPathChars > SVG_IMPORT_MAX_PATH_CHARS) failLimit("path_limit", SVG_IMPORT_MAX_PATH_CHARS, "expanded path-data characters");
    return readShape(element, css, viewport, em);
  }

  function group(children: SvgImportObject[]): SvgImportObject | undefined {
    if (!children.length) return;
    const bounds = boxForPoints(children.flatMap(object => {
      const rotation = about(rotate(object.rotation), object.x + object.width / 2, object.y + object.height / 2);
      return corners(object).map(p => point(rotation, p.x, p.y));
    }));
    return addObject({ ...bounds, id: idFactory(), type: "group", rotation: 0,
      style: {}, childObjectIds: children.map(child => child.id) });
  }

  function graphic(element: Element, css: Declarations, context: Context, report: ReportLoss): SvgImportObject | undefined {
    const { matrix, style, viewport } = context;
    const shape = sourceShape(element, css, viewport, Number(style["font-size"]));
    if (!shape) {
      report("svgImport.invalid_geometry", `Unsupported geometry on <${element.localName}>`);
      return;
    }
    if (shape.path.length < 2) return;
    const isLine = shape.primitive?.kind === "line";
    const sourceBox = shape.primitive && shape.primitive.kind !== "line" ? shape.primitive.box : pathBounds(shape.path);
    let path = transformPath(shape.path, matrix);
    if (path.some(segment => segment.slice(1).some(value => !Number.isFinite(value)))) {
      report("svgImport.invalid_geometry", "Non-finite transformed geometry");
      return;
    }
    const inkBox = shape.primitive?.kind === "ellipse" ? shapeBounds(shape, matrix) : pathBounds(path);
    if (!validBounds(sourceBox) || !validBounds(inkBox)) {
      report("svgImport.invalid_geometry", "Non-finite transformed geometry");
      return;
    }

    const width = style.stroke.toLowerCase() === "none" ? 0 : strokeWidth(style, viewport, report);
    const fillAlpha = isLine ? 0 : opacity(style["fill-opacity"], "fill-opacity", report);
    const strokeAlpha = width > 0 ? opacity(style["stroke-opacity"], "stroke-opacity", report) : 0;
    const fillVisible = fillAlpha > 0 && style.fill.toLowerCase() !== "none";
    const strokeVisible = width > 0 && strokeAlpha > 0;
    for (const key of ["marker-start", "marker-mid", "marker-end"] as const) {
      if (style[key] !== "none") report("svgImport.unsupported_attribute", `SVG ${key}`);
    }
    if (!fillVisible && !strokeVisible) return;
    let stroke: GraphicObject["style"] = {};
    if (strokeVisible) {
      const direction = shape.primitive?.kind === "line"
        ? { x: shape.primitive.to.x - shape.primitive.from.x, y: shape.primitive.to.y - shape.primitive.from.y } : undefined;
      const penScale = transformedStrokeScale(matrix, direction, style, report);
      stroke = strokeStyle(style, viewport, width, penScale, report);
      if (!Number.isFinite(stroke.strokeWidth) || stroke.strokeWidth! <= 0) {
        report("svgImport.invalid_geometry", "Unusable transformed stroke width");
        return;
      }
    }
    if (fillVisible && style["color-interpolation"] === "linearRGB") {
      report("svgImport.unsupported_attribute", "Linear RGB interpolation");
    }
    if (style["paint-order"] !== "normal" && !/^fill(?:\s+stroke(?:\s+markers)?)?$/.test(style["paint-order"])
      && fillVisible && strokeVisible) report("svgImport.unsupported_attribute", "Non-default paint order");
    let fillPath = fillVisible ? closeSubpaths(path) : path;
    // A single SVG primitive has the same filled region under either winding rule.
    if (fillVisible && style["fill-rule"] !== "nonzero" && !shape.primitive) {
      const nonzero = style["fill-rule"] === "evenodd" ? nonzeroPathForEvenOdd(path) : undefined;
      if (!nonzero) report("svgImport.fill_rule_not_kept", "Unsupported fill winding rule");
      else fillPath = nonzero;
    }
    const needsSeparateFill = fillVisible && strokeVisible && !samePath(path, fillPath);

    const clips: { shape: PreparedClip; report: ReportLoss; viewport: boolean }[] = [];
    const strokeBounds = (bounds: Bounds, matrix: Matrix): Bounds => {
      if (!strokeVisible) return bounds;
      const primitive = shape.primitive;
      if (primitive?.kind === "line" && stroke.strokeLineCap === "butt") {
        const { from, to } = primitive;
        const dx = to.x - from.x, dy = to.y - from.y;
        const size = Math.hypot(dx, dy);
        if (!size) return bounds;
        const nx = -dy / size * width / 2, ny = dx / size * width / 2;
        return boxForPoints([point(matrix, from.x + nx, from.y + ny), point(matrix, from.x - nx, from.y - ny),
          point(matrix, to.x + nx, to.y + ny), point(matrix, to.x - nx, to.y - ny)]);
      }
      const sharpCorner = !primitive || primitive.kind === "rect" && primitive.rx === 0;
      const miter = sharpCorner && stroke.strokeLineJoin === "miter" ? stroke.strokeMiterLimit ?? 4 : 1;
      const padding = width * maxScale(matrix) * Math.max(miter, stroke.strokeLineCap === "square" ? Math.SQRT2 : 1) / 2;
      return { x: bounds.x - padding, y: bounds.y - padding, width: bounds.width + 2 * padding, height: bounds.height + 2 * padding };
    };
    const fullInkBox = context.clips.length ? strokeBounds(inkBox, matrix) : inkBox;
    for (const clip of context.clips) {
      const clipReport = reportFor(clip.owner);
      const cacheable = (clip.element.getAttribute("clipPathUnits") ?? "userSpaceOnUse") === "userSpaceOnUse";
      if (!cacheable || !preparedClips.has(clip)) {
        const path = clipPath(clip, element, sourceBox, clipReport);
        const prepared = path && prepareClip(path);
        if (path && !prepared) clipReport("svgImport.clip_not_kept", "Clip has too many segments or an unsupported boundary");
        preparedClips.set(clip, prepared);
      }
      const prepared = preparedClips.get(clip);
      if (!prepared) continue;
      const relation = clipRelation(prepared, fullInkBox);
      if (relation === "outside") return;
      if (relation === "boundary") clips.push({ shape: prepared, report: clipReport, viewport: false });
    }
    for (const viewport of context.viewports) {
      const localMatrix = compose(viewport.inverseMatrix, matrix);
      const localBounds = strokeBounds(shapeBounds(shape, localMatrix), localMatrix);
      if (contains(viewport.box, localBounds)) continue;
      const relation = clipRelation(viewport.clip, strokeBounds(inkBox, matrix));
      if (relation === "outside") return;
      clips.push({ shape: viewport.clip, report, viewport: true });
    }
    let clipped = false;
    for (const clip of clips) {
      const code = clip.viewport ? "svgImport.viewport_clip_not_kept" : "svgImport.clip_not_kept";
      const current = fillVisible ? fillPath : path;
      if (!strokeVisible) {
        if (clipped && clipRelation(clip.shape, pathBounds(current)) === "outside") return;
        const intersection = intersectPaths(current, clip.shape);
        if (intersection) {
          if (intersection.roundingLoss) {
            clip.report(code, "Clip intersection may have lost geometry to rounding");
          }
          if (!intersection.path.length) return;
          if (!isLinearPath(current) || !isLinearPath(clip.shape.path)) {
            clip.report("svgImport.clip_curve_sampled", "Curves sampled during geometric clipping");
          }
          path = fillPath = intersection.path;
          clipped = true;
          continue;
        }
      }
      clip.report(code, clip.viewport ? "Ink may extend beyond the SVG viewport" : "Clip needs simple closed shapes without a stroke");
    }

    // Native primitives inset the painted outline by half their stroke width.
    // A tiny positive width for an absent stroke keeps the inset explicit.
    const primitiveWidth = stroke.strokeWidth ?? 1e-6;
    const primitive = !clipped && primitiveGeometry(shape, matrix, primitiveWidth / 2, !!stroke.strokeDasharray);
    const targetBox = primitive || (clipped ? pathBounds(path) : inkBox);
    const paintContext = { sourceBox, targetBox, matrix, viewport, byId, canonicalColor, countExpanded, report };
    const fill = fillVisible ? readPaint(style.fill, style.color, paintContext) : undefined;
    const linePaint = strokeVisible ? readPaint(style.stroke, style.color, paintContext) : undefined;
    if ((!fill || fill.kind === "none") && (!linePaint || linePaint.kind === "none")) return;
    const fillStyle = graphicPaintStyle("fill", fill, fillAlpha);
    const lineStyle = graphicPaintStyle("stroke", linePaint, strokeAlpha);
    const graphicStyle = { ...stroke, ...lineStyle, ...fillStyle, opacity: context.opacity };
    const base = { type: "graphic" as const, rotation: 0 };
    if (primitive) {
      return addObject({ ...base, ...primitive, id: idFactory(),
        style: { ...graphicStyle, strokeWidth: primitiveWidth } });
    }
    if (needsSeparateFill && fill && fill.kind !== "none" && linePaint && linePaint.kind !== "none") {
      if (context.opacity < 1) report("svgImport.group_opacity_approximated", "Opacity on separate native fill and stroke paths");
      const fillObject = addObject({ ...base, ...targetBox, id: idFactory(), graphicKind: "path",
        style: { ...fillStyle, strokePaint: { kind: "none" }, opacity: context.opacity },
        data: { pathD: encodePath(fillPath, targetBox) } });
      const strokeObject = addObject({ ...base, ...targetBox, id: idFactory(), graphicKind: "path",
        style: { ...stroke, ...lineStyle, fillPaint: { kind: "none" }, opacity: context.opacity },
        data: { pathD: encodePath(path, targetBox) } });
      return group([fillObject, strokeObject]);
    }
    const combined = fill && fill.kind !== "none" ? fillPath : path;
    return addObject({ ...base, ...targetBox, id: idFactory(), graphicKind: "path",
      style: graphicStyle, data: { pathD: encodePath(combined, targetBox) } });
  }

  function clipPath(clip: Clip, target: Element, sourceBox: Bounds, report: ReportLoss): Path | undefined {
    const clipCss = inlineStyle(clip.element, report);
    const transform = parseTransform(property(clip.element, clipCss, "transform"));
    const units = clip.element.getAttribute("clipPathUnits") ?? "userSpaceOnUse";
    const children = [...elementChildren(clip.element)].filter(child => !["title", "desc", "metadata"].includes(child.localName));
    const objectUnits = units === "objectBoundingBox";
    if (!transform || children.length !== 1
      || (units !== "userSpaceOnUse" && (!objectUnits || clip.owner !== target))
      || !clipAttributesSupported(clip.element, clipCss, ["clipPathUnits"])) {
      report("svgImport.clip_not_kept", "Unsupported clip path structure or units");
      return;
    }
    const viewport = objectUnits ? { width: 1, height: 1 } : clip.viewport;
    const rule = inheritedProperty(clip.element, "clip-rule", "nonzero", report);
    const structure = resolveClipShape(children[0], viewport, rule, report);
    if (!structure) {
      report("svgImport.clip_not_kept", "Unsupported clip path presentation");
      return;
    }
    const { shape, matrix, rule: shapeRule } = structure;
    const path = shapeRule === "evenodd" && !shape?.primitive ? shape && nonzeroPathForEvenOdd(shape.path) : shape?.path;
    if (!path || !isSimpleClosedPath(path) || (shapeRule !== "evenodd" && shapeRule !== "nonzero")) {
      report("svgImport.clip_not_kept", "Clip path is not a simple closed shape");
      return;
    }
    const basis = objectUnits ? compose(clip.matrix, compose(translate(sourceBox.x, sourceBox.y), scale(sourceBox.width, sourceBox.height)))
      : clip.matrix;
    return transformPath(path, compose(basis, compose(transform, matrix)));
  }

  function resolveClipShape(first: Element, viewport: Size, rule: string, report: ReportLoss) {
    let element = first;
    let matrix = identity;
    const visited = new Set<Element>();
    while (true) {
      const tag = element.localName;
      const allowed = tag === "use" ? useAttributes : Object.hasOwn(shapeAttributes, tag) ? shapeAttributes[tag] : undefined;
      const css = inlineStyle(element, report);
      const transform = parseTransform(property(element, css, "transform"));
      if (!allowed || !transform || !clipAttributesSupported(element, css, allowed)) return;
      matrix = compose(matrix, transform);
      const clipRule = property(element, css, "clip-rule")?.toLowerCase();
      if (clipRule && clipRule !== "inherit" && clipRule !== "unset") rule = clipRule === "initial" ? "nonzero" : clipRule;
      if (tag !== "use") return { shape: sourceShape(element, css, viewport, 16), matrix, rule };
      const link = href(element);
      const target = link?.startsWith("#") && byId.get(link.slice(1));
      if (!target) {
        report("svgImport.reference_not_kept", "Unresolved clip path reference");
        return;
      }
      if (visited.has(target)) {
        report("svgImport.reference_cycle", "Cyclic clip path reference");
        return;
      }
      if (visited.size >= SVG_IMPORT_MAX_REFERENCE_DEPTH) {
        report("svgImport.reference_depth", "Clip path reference depth exceeded");
        return;
      }
      const x = length(property(element, css, "x") ?? "0", viewport.width);
      const y = length(property(element, css, "y") ?? "0", viewport.height);
      if (x === undefined || y === undefined) return;
      matrix = compose(matrix, translate(x, y));
      visited.add(target);
      element = target;
    }
  }

  function visit(element: Element, parent: Context, depth: number, overrideViewport?: Size): SvgImportObject[] {
    countExpanded(1);
    if (depth > SVG_IMPORT_MAX_DEPTH + SVG_IMPORT_MAX_REFERENCE_DEPTH) {
      reportFor(element)("svgImport.reference_depth", "Expanded SVG nesting depth exceeded");
      return [];
    }
    const tag = element.localName;
    if (tag === "style" || (definitions.has(tag) && !(tag === "symbol" && overrideViewport))) return [];
    const report = reportFor(element);
    const css = inlineStyle(element, report);
    if (property(element, css, "display") === "none") return [];
    const isRoot = element === root;
    const transform = parseTransform(property(element, css, "transform"));
    if (!transform) report("svgImport.unsupported_attribute", `Unsupported transform on <${tag}>`);
    let matrix = compose(parent.matrix, transform ?? identity);
    if (!matrix.every(Number.isFinite) || !Number.isFinite(determinant(matrix))) {
      report("svgImport.invalid_geometry", "Non-finite SVG transform");
      return [];
    }
    if (determinant(matrix) === 0) return [];
    const style = inheritPresentation(element, css, parent.style, report);
    const rawOpacity = property(element, css, "opacity");
    const ownOpacity = rawOpacity === "inherit" ? parent.localOpacity : opacity(rawOpacity, "opacity", report);
    if (ownOpacity === 0) return [];
    const visibility = style.visibility.toLowerCase();
    // Groups and use instances pass visibility to children, which can restore it.
    if ((visibility === "hidden" || visibility === "collapse") && !groupTags.has(tag) && tag !== "use") {
      if (tag === "text" && hasTextChildren(element)) {
        report("svgImport.text_style_not_kept", "Text children may override inherited visibility");
      }
      return [];
    }
    const context: Context = { ...parent, matrix, style, localOpacity: ownOpacity, opacity: parent.opacity * ownOpacity };
    auditAttributes(element, css, report);
    for (const name of ["mask", "filter"] as const) {
      const value = property(element, css, name);
      if (value && value !== "none" && value !== "initial" && value !== "unset") {
        const code: SvgImportReportCode = name === "mask" ? "svgImport.mask_not_kept" : "svgImport.filter_not_kept";
        report(code, `SVG ${name}`);
      }
    }
    const vectorEffect = property(element, css, "vector-effect");
    if (vectorEffect && vectorEffect !== "none") report("svgImport.unsupported_attribute", "SVG vector-effect");
    const clip = property(element, css, "clip-path");
    if (clip && !["none", "initial", "unset"].includes(clip)) {
      const link = reference(clip);
      const target = link && !link.fallback && byId.get(link.id);
      if (!target || target.localName !== "clipPath") report("svgImport.clip_not_kept", "Unsupported or unresolved clip path");
      else context.clips = [...parent.clips, { owner: element, element: target, matrix, viewport: parent.viewport }];
    }

    const before = drawables;
    if (tag === "svg" || (tag === "symbol" && overrideViewport)) {
      const resolved = svgViewport(element, css, parent.viewport, isRoot ? intrinsic : overrideViewport, isRoot, report);
      if (!resolved) return [];
      if (!isRoot) {
        matrix = compose(matrix, translate(resolved.x, resolved.y));
        const overflow = property(element, css, "overflow")?.toLowerCase();
        if (overflow !== undefined && !["visible", "hidden", "clip", "auto", "scroll"].includes(overflow)) {
          report("svgImport.viewport_clip_not_kept", "Unsupported nested SVG viewport overflow");
        }
        if (overflow !== "visible") {
          const viewport = viewportClip(matrix, resolved);
          if (viewport) context.viewports = [...parent.viewports, viewport];
          else report("svgImport.viewport_clip_not_kept", "Unusable nested SVG viewport boundary");
        }
      }
      context.matrix = compose(matrix, resolved.mapping);
      context.viewport = resolved.userSize;
      context.clips = context.clips.map(item => item.owner === element
        ? { ...item, matrix: context.matrix, viewport: context.viewport } : item);
    }

    if (element.namespaceURI !== svgNamespace) {
      report("svgImport.unsupported_element", `Foreign SVG element <${tag}>`);
      return [];
    }
    if (groupTags.has(tag)) {
      if (tag === "a") report("svgImport.unsupported_element", "SVG link behavior");
      const children: SvgImportObject[] = [];
      for (const child of elementChildren(element)) {
        children.push(...visit(child, context, depth + 1));
      }
      if (drawables - before > 1 && ownOpacity < 1) {
        report("svgImport.group_opacity_approximated", "Group opacity applied to individual native objects");
      }
      const result = isRoot ? children : group(children);
      return Array.isArray(result) ? result : result ? [result] : [];
    }
    if (tag === "use") {
      const link = href(element);
      const target = link?.startsWith("#") && byId.get(link.slice(1));
      if (!target || definitions.has(target.localName) && target.localName !== "symbol") {
        report("svgImport.reference_not_kept", "Unresolved or unsupported <use> reference");
        return [];
      }
      if (context.references.includes(target)) {
        report("svgImport.reference_cycle", "Cyclic <use> reference");
        return [];
      }
      if (context.references.length >= SVG_IMPORT_MAX_REFERENCE_DEPTH) {
        report("svgImport.reference_depth", "<use> reference depth exceeded");
        return [];
      }
      const em = Number(context.style["font-size"]);
      const x = length(property(element, css, "x") ?? "0", context.viewport.width, em);
      const y = length(property(element, css, "y") ?? "0", context.viewport.height, em);
      if (x === undefined || y === undefined) {
        report("svgImport.invalid_geometry", "Unsupported <use> position");
        return [];
      }
      let size: Size | undefined;
      if (target.localName === "symbol" || target.localName === "svg") {
        const width = length(property(element, css, "width") ?? target.getAttribute("width") ?? "100%", context.viewport.width, em);
        const height = length(property(element, css, "height") ?? target.getAttribute("height") ?? "100%", context.viewport.height, em);
        if (width === undefined || height === undefined || width < 0 || height < 0) {
          report("svgImport.invalid_geometry", "Unsupported <use> viewport dimensions");
          return [];
        }
        if (width === 0 || height === 0) return [];
        size = { width, height };
      }
      const result = visit(target, { ...context, matrix: compose(matrix, translate(x, y)),
        references: [...context.references, target] }, depth + 1, size);
      if (drawables - before > 1 && ownOpacity < 1) {
        report("svgImport.group_opacity_approximated", "Group opacity applied to individual native objects");
      }
      return result;
    }
    if (tag === "text") {
      const text = readText(element, css, style, matrix, context.viewport, context.opacity, canonicalColor, report);
      if (!text) return [];
      for (const item of context.clips) reportFor(item.owner)("svgImport.clip_not_kept", "Clip cannot be applied to editable text");
      if (context.viewports.length) {
        // The SVG may use arbitrary fonts and fallback glyphs. Without metrics
        // there is no reliable upper bound on advance, ink overhang, ascent or
        // descent. The unknown advance also shifts middle and end anchors.
        report("svgImport.viewport_clip_not_kept", "Text ink bounds cannot be verified against the SVG viewport");
      }
      return [addObject({ id: idFactory(), ...text })];
    }
    if (Object.hasOwn(shapeAttributes, tag)) {
      const object = graphic(element, css, context, report);
      return object ? [object] : [];
    }
    if (tag === "image") report("svgImport.image_not_kept", "Embedded SVG image element");
    else report("svgImport.unsupported_element", `Unsupported SVG element <${tag}>`);
    return [];
  }

  const intrinsic = readSvgInfo(svgSource)?.physicalSize ?? { width: 300, height: 150 };
  const rotation = about(rotate(frame.rotation), frame.x + frame.width / 2, frame.y + frame.height / 2);
  const frameMatrix = compose(rotation, translate(frame.x, frame.y));
  const viewport = viewportClip(frameMatrix, frame);
  if (!viewport) throw new SvgImportError("invalid_frame", "SVG import could not place the picture viewport in its page frame.");
  const stretch = scale(frame.width / intrinsic.width, frame.height / intrinsic.height);
  const roots = visit(root, { matrix: compose(frameMatrix, stretch), style: defaultPresentation, viewport: intrinsic,
    viewports: [viewport], clips: [], opacity: 1, localOpacity: 1, references: [] }, 1);
  return { objects, selectionIds: roots.map(object => object.id), report: { exact: entries.size === 0, entries: [...entries.values()] } };
}

function failLimit(code: SvgImportErrorCode, limit: number, description: string): never {
  throw new SvgImportError(code, `SVG import exceeds the limit of ${limit} ${description}.`);
}

function indexSource(root: Element) {
  const byId = new Map<string, Element>();
  const stylesheets: Element[] = [];
  const pending: [Element, number][] = [[root, 1]];
  let count = 0, pathChars = 0;
  while (pending.length) {
    const [element, depth] = pending.pop()!;
    if (++count > SVG_IMPORT_MAX_ELEMENTS) failLimit("element_limit", SVG_IMPORT_MAX_ELEMENTS, "SVG elements");
    if (depth > SVG_IMPORT_MAX_DEPTH) failLimit("depth_limit", SVG_IMPORT_MAX_DEPTH, "SVG nesting levels");
    pathChars += (element.getAttribute("d")?.length ?? 0) + (element.getAttribute("points")?.length ?? 0);
    if (pathChars > SVG_IMPORT_MAX_PATH_CHARS) failLimit("path_limit", SVG_IMPORT_MAX_PATH_CHARS, "source path-data characters");
    const id = element.getAttribute("id");
    if (id && !byId.has(id)) byId.set(id, element);
    if (element.localName === "style" && element.textContent?.trim()) stylesheets.push(element);
    for (let child = element.lastElementChild; child; child = child.previousElementSibling) pending.push([child, depth + 1]);
  }
  return { byId, stylesheets };
}

function auditAttributes(element: Element, css: Declarations, report: ReportLoss): void {
  const tag = element.localName;
  const wanted = Object.hasOwn(shapeAttributes, tag) ? shapeAttributes[tag] : tag === "text" ? textAttributes
    : tag === "use" ? useAttributes : tag === "svg" || tag === "symbol" ? viewportAttributes : [];
  for (const name of new Set([...element.getAttributeNames(), ...css.keys()])) {
    if (!commonAttributes.has(name) && !wanted.includes(name) && !isPresentation(name)
      && !/^(?:aria-|data-|xmlns:)/.test(name)) {
      report("svgImport.unsupported_attribute", `Unsupported <${tag}> property ${name}`);
    }
  }
}

function clipAttributesSupported(element: Element, css: Declarations, geometry: readonly string[]): boolean {
  return [...element.getAttributeNames(), ...css.keys()].every(name => commonAttributes.has(name) || ignoredClipPaint.has(name)
    || geometry.includes(name) || name === "transform" || name === "clip-rule" || /^(?:aria-|data-|xmlns:)/.test(name));
}

function svgViewport(element: Element, css: Declarations, available: Size, fixed: Size | undefined,
  root: boolean, report: ReportLoss) {
  const value = (name: string, basis: number, fallback: number) => {
    const authored = property(element, css, name);
    return authored === undefined || authored === "auto" ? fallback : length(authored, basis);
  };
  if (root && (css.has("width") || css.has("height"))) {
    report("svgImport.unsupported_attribute", "CSS sizing on the root SVG viewport");
  }
  if (root && ["width", "height"].some(name => length(property(element, css, name) ?? "", 1) === 0)) return;
  const width = fixed?.width ?? value("width", available.width, available.width);
  const height = fixed?.height ?? value("height", available.height, available.height);
  const x = root ? 0 : value("x", available.width, 0);
  const y = root ? 0 : value("y", available.height, 0);
  if (width === undefined || height === undefined || x === undefined || y === undefined || width < 0 || height < 0) {
    report("svgImport.invalid_geometry", "Unsupported SVG viewport dimensions");
    return;
  }
  if (width === 0 || height === 0) return;
  const viewport = { width, height };
  const rawBox = element.getAttribute("viewBox");
  const box = rawBox ? readViewBox(rawBox) : undefined;
  if (rawBox !== null && !box) report("svgImport.invalid_geometry", "Unsupported SVG viewBox");
  const rawAlign = element.getAttribute("preserveAspectRatio") ?? "xMidYMid meet";
  const mapping = box ? viewportMatrix(box, viewport, rawAlign) : identity;
  if (!mapping) report("svgImport.unsupported_attribute", "Unsupported preserveAspectRatio");
  return { x, y, ...viewport, userSize: box ?? viewport,
    mapping: mapping ?? viewportMatrix(box!, viewport, "xMidYMid meet")! };
}

function viewportClip(matrix: Matrix, size: Size): Viewport | undefined {
  const box = { x: 0, y: 0, width: size.width, height: size.height };
  const inverseMatrix = inverse(matrix);
  const clip = prepareClip(transformPath(polygonPath(corners(box), true), matrix));
  if (clip && inverseMatrix.every(Number.isFinite)) return { inverseMatrix, box, clip };
}

function contains(outer: Bounds, inner: Bounds): boolean {
  const tolerance = 32 * Number.EPSILON * Math.max(1, outer.width, outer.height);
  return inner.x >= outer.x - tolerance && inner.y >= outer.y - tolerance
    && inner.x + inner.width <= outer.x + outer.width + tolerance
    && inner.y + inner.height <= outer.y + outer.height + tolerance;
}

function samePath(first: Path, second: Path): boolean {
  return first.length === second.length && first.every((segment, index) =>
    segment === second[index] || (segment.length === second[index].length && segment.every((value, coordinate) => value === second[index][coordinate])));
}
