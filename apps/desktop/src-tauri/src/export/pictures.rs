//! Bitmap pictures in raster export, drawn without a native image decoder.
//!
//! resvg is built without `raster-images`, so it never decodes a bitmap. The webview decodes each
//! PNG picture instead (`rasterPictureDecode.ts`) and sends straight-alpha RGBA8 pixels that are
//! checked here by size and length alone. In the SVG, the picture's `<image>` keeps its frame and
//! z-order but carries an id and an empty stand-in SVG of the picture's pixel size, so usvg still
//! resolves its placement (`preserveAspectRatio`, transforms, clipping) exactly as for any image.
//! The tree is then rendered node by node: everything through resvg, and each stand-in from the
//! supplied pixels with the same transform and sampling resvg would give a decoded bitmap.
//!
//! A picture that cannot be drawn exactly (inside a mask, filter, blend mode, pattern or marker)
//! is not drawn at all and gets a warning, as do pictures the webview refused to decode.

use std::collections::{HashMap, HashSet};

use resvg::{tiny_skia, usvg};

use super::{warning, RasterExportWarning};

pub(super) const MAX_PICTURE_SIDE_PX: u32 = 16384;
/// Decoded pixels (width × height × 4) across all pictures of one export.
pub(super) const MAX_DECODED_PICTURE_BYTES: u64 = 256 * 1024 * 1024;
pub(super) const MAX_PICTURES: usize = 1024;
pub(super) const PICTURE_ID_PREFIX: &str = "chemdraft-raster-picture-";
const MAX_PICTURE_ID_LEN: usize = 64;
const SVG_NAMESPACE: &str = "http://www.w3.org/2000/svg";

/// One picture of a raster export request: decoded pixels, or why the webview refused it.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RasterPictureInput {
    pub(super) id: String,
    pub(super) width: Option<u32>,
    pub(super) height: Option<u32>,
    /// Straight-alpha RGBA8, row-major, standard padded base64.
    pub(super) rgba_base64: Option<String>,
    pub(super) refused: Option<PictureRefusal>,
}

#[derive(Clone, Copy, Debug, serde::Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(super) enum PictureRefusal {
    TooLarge,
    OverBudget,
    DecodeFailed,
}

/// Why a picture is missing from the raster output.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Omission {
    Refused(PictureRefusal),
    Unplaceable,
}

/// The empty SVG standing in for a picture; `rasterPicturePlaceholderHref` builds the same string.
pub(super) fn placeholder_href(width: u32, height: u32) -> String {
    format!("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='{width}'%20height='{height}'/%3E")
}

enum Supplied {
    Decoded(tiny_skia::Pixmap),
    Refused(PictureRefusal),
}

/// The pictures of one request, validated and unpacked into premultiplied pixmaps.
pub(super) struct SuppliedPictures {
    pictures: HashMap<String, Supplied>,
}

impl SuppliedPictures {
    pub(super) fn from_request(
        inputs: Vec<RasterPictureInput>,
        label: &str,
    ) -> Result<Self, String> {
        let invalid = |detail: String| {
            format!("Could not export {label}: the picture data sent for raster export is invalid ({detail}).")
        };
        if inputs.len() > MAX_PICTURES {
            return Err(invalid(format!(
                "{} pictures; the limit is {MAX_PICTURES}",
                inputs.len()
            )));
        }

        // Check every id, size and the per-export total first, then the payload lengths, and only
        // then unpack any pixels, so an oversized request allocates nothing.
        let mut ids = HashSet::new();
        let mut total_bytes = 0u64;
        for input in &inputs {
            let id = &input.id;
            if !valid_picture_id(id) || !ids.insert(id.as_str()) {
                return Err(invalid(format!(
                    "picture id {id:?} is malformed or repeated"
                )));
            }
            match (&input.rgba_base64, input.refused) {
                (Some(_), None) => {
                    let (width, height) = (input.width.unwrap_or(0), input.height.unwrap_or(0));
                    if !(1..=MAX_PICTURE_SIDE_PX).contains(&width)
                        || !(1..=MAX_PICTURE_SIDE_PX).contains(&height)
                    {
                        return Err(invalid(format!(
                            "picture {id} is {width} × {height} px; each side must be 1 to {MAX_PICTURE_SIDE_PX} px"
                        )));
                    }
                    total_bytes += u64::from(width) * u64::from(height) * 4;
                    if total_bytes > MAX_DECODED_PICTURE_BYTES {
                        return Err(invalid(format!(
                            "the pictures exceed {} MiB of decoded pixels",
                            MAX_DECODED_PICTURE_BYTES / (1024 * 1024)
                        )));
                    }
                }
                (None, Some(_)) => {}
                _ => {
                    return Err(invalid(format!(
                        "picture {id} must carry either pixels or a refusal"
                    )))
                }
            }
        }
        for input in &inputs {
            if let (Some(rgba_base64), Some(width), Some(height)) =
                (&input.rgba_base64, input.width, input.height)
            {
                let bytes = u64::from(width) * u64::from(height) * 4;
                if rgba_base64.len() as u64 != bytes.div_ceil(3) * 4 {
                    return Err(invalid(format!(
                        "picture {} does not carry {width} × {height} RGBA pixels",
                        input.id
                    )));
                }
            }
        }

        let mut pictures = HashMap::with_capacity(inputs.len());
        for input in inputs {
            let supplied = match (input.rgba_base64, input.refused) {
                (Some(rgba_base64), _) => {
                    let (width, height) = (input.width.unwrap_or(0), input.height.unwrap_or(0));
                    let mut rgba = base64::Engine::decode(
                        &base64::engine::general_purpose::STANDARD,
                        rgba_base64,
                    )
                    .map_err(|error| {
                        invalid(format!("picture {} is not valid base64: {error}", input.id))
                    })?;
                    premultiply(&mut rgba);
                    let pixmap = tiny_skia::IntSize::from_wh(width, height)
                        .and_then(|size| tiny_skia::Pixmap::from_vec(rgba, size))
                        .ok_or_else(|| {
                            invalid(format!(
                                "picture {} does not carry {width} × {height} RGBA pixels",
                                input.id
                            ))
                        })?;
                    Supplied::Decoded(pixmap)
                }
                (None, Some(refusal)) => Supplied::Refused(refusal),
                (None, None) => unreachable!("validated above"),
            };
            pictures.insert(input.id, supplied);
        }
        Ok(Self { pictures })
    }

    pub(super) fn is_empty(&self) -> bool {
        self.pictures.is_empty()
    }

    fn expected_href(&self, id: &str) -> Option<String> {
        Some(match self.pictures.get(id)? {
            Supplied::Decoded(pixmap) => placeholder_href(pixmap.width(), pixmap.height()),
            Supplied::Refused(_) => placeholder_href(1, 1),
        })
    }

    /// The supplied pictures whose stand-in is in the SVG: exactly one SVG `<image>` with the id
    /// and a single href equal to the expected stand-in. Maps each id to whether it is inside a
    /// `<marker>` (usvg strips ids there, so such a picture can never be placed).
    pub(super) fn find_stand_ins(
        &self,
        document: &usvg::roxmltree::Document<'_>,
    ) -> HashMap<String, bool> {
        let mut elements: HashMap<&str, Vec<usvg::roxmltree::Node<'_, '_>>> = HashMap::new();
        for node in document.descendants().filter(|node| node.is_element()) {
            if let Some(id) = node.attribute("id") {
                if self.pictures.contains_key(id) {
                    elements.entry(id).or_default().push(node);
                }
            }
        }
        elements
            .into_iter()
            .filter_map(|(id, nodes)| {
                let [node] = nodes.as_slice() else {
                    return None;
                };
                let is_svg_image = node.tag_name().name() == "image"
                    && node.tag_name().namespace() == Some(SVG_NAMESPACE);
                let mut hrefs = node.attributes().filter(|attr| attr.name() == "href");
                let href = hrefs.next()?;
                let expected = self.expected_href(id)?;
                (is_svg_image && hrefs.next().is_none() && href.value() == expected).then(|| {
                    let in_marker = node.ancestors().any(|ancestor| {
                        ancestor.tag_name().name() == "marker"
                            && ancestor.tag_name().namespace() == Some(SVG_NAMESPACE)
                    });
                    (id.to_string(), in_marker)
                })
            })
            .collect()
    }

    /// Renders `tree` as `resvg::render` would, plus every placeable decoded picture.
    /// Returns the ids of the pictures drawn.
    pub(super) fn render(
        &self,
        tree: &usvg::Tree,
        stand_ins: &HashMap<String, bool>,
        transform: tiny_skia::Transform,
        canvas: &mut tiny_skia::PixmapMut<'_>,
    ) -> HashSet<String> {
        let pixmaps: HashMap<&str, &tiny_skia::Pixmap> = self
            .pictures
            .iter()
            .filter_map(|(id, supplied)| match supplied {
                Supplied::Decoded(pixmap) if stand_ins.get(id) == Some(&false) => {
                    Some((id.as_str(), pixmap))
                }
                _ => None,
            })
            .collect();
        if pixmaps.is_empty() {
            resvg::render(tree, transform, canvas);
            return HashSet::new();
        }

        let mut renderer = PictureRenderer {
            pixmaps: &pixmaps,
            drawn: HashSet::new(),
            unplaceable: HashSet::new(),
        };
        let root = tree.root();
        if renderer.can_render_children(root) {
            renderer.render_children(root, None, transform, canvas);
        } else {
            resvg::render(tree, transform, canvas);
            renderer.mark(root, None, false);
        }
        // Pictures used by patterns, masks, clip paths or filter images are drawn there by resvg,
        // which has no pixels for them; report them rather than show them only in some places.
        renderer.mark_subroot_pictures(root, false);
        let PictureRenderer {
            drawn, unplaceable, ..
        } = renderer;
        drawn
            .into_iter()
            .filter(|id| !unplaceable.contains(id))
            .collect()
    }

    /// One warning per reason, counting the pictures in the SVG that were not drawn.
    pub(super) fn omission_warnings(
        &self,
        stand_ins: &HashMap<String, bool>,
        drawn: &HashSet<String>,
        label: &str,
    ) -> Vec<RasterExportWarning> {
        let mut counts: HashMap<Omission, usize> = HashMap::new();
        for (id, supplied) in &self.pictures {
            if !stand_ins.contains_key(id) {
                continue;
            }
            let omission = match supplied {
                Supplied::Refused(refusal) => Omission::Refused(*refusal),
                Supplied::Decoded(_) if drawn.contains(id) => continue,
                Supplied::Decoded(_) => Omission::Unplaceable,
            };
            *counts.entry(omission).or_default() += 1;
        }
        [
            Omission::Refused(PictureRefusal::TooLarge),
            Omission::Refused(PictureRefusal::OverBudget),
            Omission::Refused(PictureRefusal::DecodeFailed),
            Omission::Unplaceable,
        ]
        .into_iter()
        .filter_map(|omission| {
            let count = *counts.get(&omission)?;
            Some(omission_warning(label, count, omission))
        })
        .collect()
    }
}

fn omission_warning(label: &str, count: usize, omission: Omission) -> RasterExportWarning {
    let (pictures, were, them) = if count == 1 {
        ("1 picture".to_string(), "was", "it")
    } else {
        (format!("{count} pictures"), "were", "them")
    };
    let budget_mib = MAX_DECODED_PICTURE_BYTES / (1024 * 1024);
    let message = match omission {
        Omission::Refused(PictureRefusal::TooLarge) => format!(
            "{label} export: {pictures} larger than {MAX_PICTURE_SIDE_PX} px on a side {were} not included; export SVG or PDF to include {them}."
        ),
        Omission::Refused(PictureRefusal::OverBudget) => format!(
            "{label} export: {pictures} {were} not included because the pictures in this export exceed {budget_mib} MiB once decoded; export SVG or PDF to include {them}."
        ),
        Omission::Refused(PictureRefusal::DecodeFailed) => format!(
            "{label} export: {pictures} could not be decoded and {were} not included; export SVG or PDF to include {them}."
        ),
        Omission::Unplaceable => format!(
            "{label} export: {pictures} inside a mask, filter, blend mode, pattern or marker {were} not included; export SVG or PDF to include {them}."
        ),
    };
    warning("raster_pictures_omitted", message)
}

fn valid_picture_id(id: &str) -> bool {
    id.len() <= MAX_PICTURE_ID_LEN
        && id.strip_prefix(PICTURE_ID_PREFIX).is_some_and(|rest| {
            !rest.is_empty()
                && rest
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

/// Straight to premultiplied alpha, in place; tiny-skia pixmaps are premultiplied.
fn premultiply(rgba: &mut [u8]) {
    for pixel in rgba.chunks_exact_mut(4) {
        let alpha = u16::from(pixel[3]);
        if alpha == 255 {
            continue;
        }
        for channel in &mut pixel[..3] {
            *channel = ((u16::from(*channel) * alpha + 127) / 255) as u8;
        }
    }
}

struct PictureRenderer<'p> {
    pixmaps: &'p HashMap<&'p str, &'p tiny_skia::Pixmap>,
    drawn: HashSet<String>,
    unplaceable: HashSet<String>,
}

impl PictureRenderer<'_> {
    fn picture_id<'t>(&self, group: &'t usvg::Group) -> Option<&'t str> {
        let id = group.id();
        self.pixmaps.contains_key(id).then_some(id)
    }

    fn contains_pictures(&self, group: &usvg::Group) -> bool {
        group.children().iter().any(|node| match node {
            usvg::Node::Group(child) => {
                self.pixmaps.contains_key(child.id()) || self.contains_pictures(child)
            }
            _ => false,
        })
    }

    /// Whether each child can be drawn on its own. `resvg::render_node` skips a node without a
    /// layer box, which for a bare horizontal or vertical stroked line would lose the line; such
    /// a line is stroked here instead, which is only done for a plain colour.
    fn can_render_children(&self, group: &usvg::Group) -> bool {
        group.children().iter().all(|node| match node {
            usvg::Node::Path(path) if node.abs_layer_bounding_box().is_none() => path
                .stroke()
                .is_none_or(|stroke| matches!(stroke.paint(), usvg::Paint::Color(_))),
            _ => true,
        })
    }

    fn render_children<'t>(
        &mut self,
        parent: &'t usvg::Group,
        picture: Option<&'t str>,
        transform: tiny_skia::Transform,
        canvas: &mut tiny_skia::PixmapMut<'_>,
    ) {
        for node in parent.children() {
            self.render_node(node, picture, transform, canvas);
        }
    }

    /// `picture` is the id of the enclosing picture wrapper, which usvg puts around the image.
    fn render_node<'t>(
        &mut self,
        node: &'t usvg::Node,
        picture: Option<&'t str>,
        transform: tiny_skia::Transform,
        canvas: &mut tiny_skia::PixmapMut<'_>,
    ) {
        match node {
            usvg::Node::Group(group) => {
                let picture = self.picture_id(group).or(picture);
                if picture.is_none() && !self.contains_pictures(group) {
                    render_with_resvg(node, transform, canvas);
                } else {
                    self.render_group(node, group, picture, transform, canvas);
                }
            }
            usvg::Node::Image(image) if matches!(image.kind(), usvg::ImageKind::SVG(_)) => {
                let pixmaps = self.pixmaps;
                match picture.and_then(|id| pixmaps.get(id).map(|pixmap| (id, *pixmap))) {
                    Some((id, pixmap)) => {
                        self.drawn.insert(id.to_string());
                        draw_picture(image, pixmap, transform, canvas);
                    }
                    None => render_with_resvg(node, transform, canvas),
                }
            }
            usvg::Node::Path(path) if node.abs_layer_bounding_box().is_none() => {
                stroke_degenerate_path(path, transform, canvas);
            }
            _ => render_with_resvg(node, transform, canvas),
        }
    }

    fn render_group<'t>(
        &mut self,
        node: &'t usvg::Node,
        group: &'t usvg::Group,
        picture: Option<&'t str>,
        parent_transform: tiny_skia::Transform,
        canvas: &mut tiny_skia::PixmapMut<'_>,
    ) {
        // Mask, filter and blend effects are left to resvg, without the pictures they contain.
        let unsupported_effect = group.mask().is_some()
            || !group.filters().is_empty()
            || group.blend_mode() != usvg::BlendMode::Normal;
        if unsupported_effect || !self.can_render_children(group) {
            self.mark(group, picture, false);
            render_with_resvg(node, parent_transform, canvas);
            return;
        }

        let transform = parent_transform.pre_concat(group.transform());
        if !group.should_isolate() {
            self.render_children(group, picture, transform, canvas);
            return;
        }

        // Opacity and clip-path need a layer, as in resvg's render_group. It is cropped to the
        // canvas: neither effect reads outside its own pixel, so nothing on the canvas changes.
        let Some(bbox) = group.layer_bounding_box().transform(transform) else {
            // A degenerate transform: nothing of the group is visible.
            self.mark(group, picture, true);
            return;
        };
        let left = (bbox.left().floor() - 2.0).max(0.0);
        let top = (bbox.top().floor() - 2.0).max(0.0);
        let right = (bbox.right().ceil() + 2.0).min(canvas.width() as f32);
        let bottom = (bbox.bottom().ceil() + 2.0).min(canvas.height() as f32);
        let on_canvas = left < right && top < bottom;
        if !on_canvas {
            self.mark(group, picture, true);
            return;
        }
        let (x, y) = (left as i32, top as i32);
        let Some(mut layer) =
            tiny_skia::Pixmap::new((right as i32 - x) as u32, (bottom as i32 - y) as u32)
        else {
            self.mark(group, picture, false);
            render_with_resvg(node, parent_transform, canvas);
            return;
        };
        let layer_transform =
            tiny_skia::Transform::from_translate(-(x as f32), -(y as f32)).pre_concat(transform);
        self.render_children(group, picture, layer_transform, &mut layer.as_mut());
        if let Some(clip) = group.clip_path() {
            if apply_clip(clip, layer_transform, &mut layer).is_none() {
                self.mark(group, picture, false);
                render_with_resvg(node, parent_transform, canvas);
                return;
            }
        }
        canvas.draw_pixmap(
            x,
            y,
            layer.as_ref(),
            &tiny_skia::PixmapPaint {
                opacity: group.opacity().get(),
                blend_mode: tiny_skia::BlendMode::SourceOver,
                quality: tiny_skia::FilterQuality::Nearest,
            },
            tiny_skia::Transform::identity(),
            None,
        );
    }

    /// Records every picture in `group` (and the enclosing `picture`) as drawn — used when nothing
    /// of the group can be visible — or as impossible to place exactly.
    fn mark(&mut self, group: &usvg::Group, picture: Option<&str>, drawn: bool) {
        let mut ids: Vec<String> = picture.map(str::to_string).into_iter().collect();
        self.collect_picture_ids(group, &mut ids);
        let target = if drawn {
            &mut self.drawn
        } else {
            &mut self.unplaceable
        };
        target.extend(ids);
    }

    fn collect_picture_ids(&self, group: &usvg::Group, ids: &mut Vec<String>) {
        for node in group.children() {
            if let usvg::Node::Group(child) = node {
                if self.pixmaps.contains_key(child.id()) {
                    ids.push(child.id().to_string());
                }
                self.collect_picture_ids(child, ids);
            }
        }
    }

    fn mark_subroot_pictures(&mut self, parent: &usvg::Group, in_subroot: bool) {
        for node in parent.children() {
            if let usvg::Node::Group(group) = node {
                if in_subroot && self.pixmaps.contains_key(group.id()) {
                    self.unplaceable.insert(group.id().to_string());
                }
                self.mark_subroot_pictures(group, in_subroot);
            }
            node.subroots(|subroot| self.mark_subroot_pictures(subroot, true));
        }
    }
}

/// Draws one node exactly where `resvg::render` would. `resvg::render_node` offsets the node by
/// its own layer box (it is meant for rendering a node on its own); that offset is undone here.
fn render_with_resvg(
    node: &usvg::Node,
    transform: tiny_skia::Transform,
    canvas: &mut tiny_skia::PixmapMut<'_>,
) {
    if let Some(bbox) = node.abs_layer_bounding_box() {
        resvg::render_node(node, transform.pre_translate(bbox.x(), bbox.y()), canvas);
    } else if let usvg::Node::Text(text) = node {
        // A text box of zero size; render its outlines as resvg does.
        let flattened = usvg::Node::Group(Box::new(text.flattened().clone()));
        render_with_resvg(&flattened, transform, canvas);
    }
}

/// Draws a picture as resvg draws a decoded bitmap: its pixel rectangle under the image transform.
fn draw_picture(
    image: &usvg::Image,
    pixmap: &tiny_skia::Pixmap,
    transform: tiny_skia::Transform,
    canvas: &mut tiny_skia::PixmapMut<'_>,
) {
    if !image.is_visible() {
        return;
    }
    let size = image.size();
    let Some(rect) = tiny_skia::Rect::from_xywh(0.0, 0.0, size.width(), size.height()) else {
        return;
    };
    let quality = match image.rendering_mode() {
        usvg::ImageRendering::OptimizeQuality | usvg::ImageRendering::HighQuality => {
            tiny_skia::FilterQuality::Bicubic
        }
        usvg::ImageRendering::Smooth => tiny_skia::FilterQuality::Bilinear,
        usvg::ImageRendering::OptimizeSpeed
        | usvg::ImageRendering::CrispEdges
        | usvg::ImageRendering::Pixelated => tiny_skia::FilterQuality::Nearest,
    };
    let paint = tiny_skia::Paint {
        shader: tiny_skia::Pattern::new(
            pixmap.as_ref(),
            tiny_skia::SpreadMode::Pad,
            quality,
            1.0,
            tiny_skia::Transform::from_scale(
                size.width() / pixmap.width() as f32,
                size.height() / pixmap.height() as f32,
            ),
        ),
        ..Default::default()
    };
    canvas.fill_rect(rect, &paint, transform, None);
}

/// A path whose fill box has no area. resvg never fills such a path, so only its stroke shows;
/// this matches resvg's stroke for a plain colour (`can_render_children` admits no other paint).
fn stroke_degenerate_path(
    path: &usvg::Path,
    transform: tiny_skia::Transform,
    canvas: &mut tiny_skia::PixmapMut<'_>,
) {
    let Some(stroke) = path.stroke().filter(|_| path.is_visible()) else {
        return;
    };
    let usvg::Paint::Color(color) = stroke.paint() else {
        return;
    };
    let mut paint = tiny_skia::Paint::default();
    paint.set_color_rgba8(color.red, color.green, color.blue, stroke.opacity().to_u8());
    paint.anti_alias = path.rendering_mode().use_shape_antialiasing();
    canvas.stroke_path(path.data(), &paint, &stroke.to_tiny_skia(), transform, None);
}

// resvg's clip-path application (resvg 0.47, src/clip.rs), which is private to resvg.

fn apply_clip(
    clip: &usvg::ClipPath,
    transform: tiny_skia::Transform,
    pixmap: &mut tiny_skia::Pixmap,
) -> Option<()> {
    let mut clip_pixmap = tiny_skia::Pixmap::new(pixmap.width(), pixmap.height())?;
    clip_pixmap.fill(tiny_skia::Color::BLACK);
    draw_clip_children(
        clip.root(),
        tiny_skia::BlendMode::Clear,
        transform.pre_concat(clip.transform()),
        &mut clip_pixmap.as_mut(),
    )?;
    if let Some(clip) = clip.clip_path() {
        apply_clip(clip, transform, pixmap)?;
    }
    let mut mask = tiny_skia::Mask::from_pixmap(clip_pixmap.as_ref(), tiny_skia::MaskType::Alpha);
    mask.invert();
    pixmap.apply_mask(&mask);
    Some(())
}

fn draw_clip_children(
    parent: &usvg::Group,
    mode: tiny_skia::BlendMode,
    transform: tiny_skia::Transform,
    pixmap: &mut tiny_skia::PixmapMut<'_>,
) -> Option<()> {
    for child in parent.children() {
        match child {
            usvg::Node::Path(path) => {
                if path.is_visible() {
                    fill_clip_path(path, mode, transform, pixmap);
                }
            }
            usvg::Node::Text(text) => {
                draw_clip_children(text.flattened(), mode, transform, pixmap)?
            }
            usvg::Node::Group(group) => {
                let transform = transform.pre_concat(group.transform());
                match group.clip_path() {
                    Some(clip) => clip_group(group, clip, transform, pixmap)?,
                    None => draw_clip_children(group, mode, transform, pixmap)?,
                }
            }
            usvg::Node::Image(_) => {}
        }
    }
    Some(())
}

fn clip_group(
    children: &usvg::Group,
    clip: &usvg::ClipPath,
    transform: tiny_skia::Transform,
    pixmap: &mut tiny_skia::PixmapMut<'_>,
) -> Option<()> {
    let mut clip_pixmap = tiny_skia::Pixmap::new(pixmap.width(), pixmap.height())?;
    draw_clip_children(
        children,
        tiny_skia::BlendMode::SourceOver,
        transform,
        &mut clip_pixmap.as_mut(),
    )?;
    apply_clip(clip, transform, &mut clip_pixmap)?;
    let paint = tiny_skia::PixmapPaint {
        blend_mode: tiny_skia::BlendMode::Xor,
        ..Default::default()
    };
    pixmap.draw_pixmap(
        0,
        0,
        clip_pixmap.as_ref(),
        &paint,
        tiny_skia::Transform::identity(),
        None,
    );
    Some(())
}

/// resvg's `fill_path` for clip-path children, which usvg always gives a plain black fill.
fn fill_clip_path(
    path: &usvg::Path,
    mode: tiny_skia::BlendMode,
    transform: tiny_skia::Transform,
    pixmap: &mut tiny_skia::PixmapMut<'_>,
) {
    let Some(fill) = path.fill() else {
        return;
    };
    let bounds = path.data().bounds();
    if bounds.width() == 0.0 || bounds.height() == 0.0 {
        return;
    }
    let rule = match fill.rule() {
        usvg::FillRule::NonZero => tiny_skia::FillRule::Winding,
        usvg::FillRule::EvenOdd => tiny_skia::FillRule::EvenOdd,
    };
    let mut paint = tiny_skia::Paint::default();
    match fill.paint() {
        usvg::Paint::Color(color) => {
            paint.set_color_rgba8(color.red, color.green, color.blue, fill.opacity().to_u8())
        }
        _ => paint.set_color_rgba8(0, 0, 0, fill.opacity().to_u8()),
    }
    paint.anti_alias = path.rendering_mode().use_shape_antialiasing();
    paint.blend_mode = mode;
    pixmap.fill_path(path.data(), &paint, rule, transform, None);
}
