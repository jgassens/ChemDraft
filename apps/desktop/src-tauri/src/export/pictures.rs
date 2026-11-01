//! Bitmap pictures in raster export, drawn without a native image decoder.
//!
//! resvg is built without `raster-images`, so it never decodes a bitmap. The webview decodes each
//! PNG picture instead (`rasterPictureDecode.ts`) and sends straight-alpha RGBA8 pixels that are
//! checked here by size and length alone. In the SVG, the picture's `<image>` keeps its frame and
//! z-order but carries an id and a blank stand-in SVG of the picture's pixel size, so usvg still
//! resolves its placement (`preserveAspectRatio`, transforms, clipping) exactly as for any image.
//! The stand-in holds one invisible path whose id is the picture's, so every copy of it names its
//! picture, even where usvg has dropped the `<image>`'s own id.
//! The tree is then rendered node by node: everything through resvg, and each stand-in from the
//! supplied pixels with the same transform and sampling resvg would give a decoded bitmap.
//!
//! A picture copy that cannot be drawn exactly (inside a mask, filter, blend mode, pattern or
//! marker) is not drawn and gets a warning, counted per rendered copy, as do pictures the webview
//! refused to decode or left out because the export has more than `MAX_PICTURES` of them. usvg
//! drops the ids of copies made by reference (`<use>`, `<feImage>`), so those copies are never
//! drawn either; they are found by the picture id inside their stand-in and counted as left out.

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
const PLACEHOLDER_HREF_START: &str =
    "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='";
const PLACEHOLDER_HREF_MIDDLE: &str = "'%20height='";
const PLACEHOLDER_HREF_ID: &str = "'%3E%3Cpath%20id='";
const PLACEHOLDER_HREF_END: &str = "'%20d='M0%200H1V1H0Z'%20fill='none'/%3E%3C/svg%3E";
/// The stand-in for a PNG picture the webview neither decoded nor sent, because the export already
/// had `MAX_PICTURES` pictures; `RasterPictureOverCountHref` is the same string.
pub(super) const OVER_COUNT_HREF: &str = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='1'%20height='1'%20data-chemdraft-omitted='count'/%3E";

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

/// Why a picture, or some copies of it, are missing from the raster output.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Omission {
    Refused(PictureRefusal),
    OverCount,
    Unplaceable,
    SomeCopies,
}

/// How many rendered copies of one picture were drawn and how many were left out. A picture
/// shown again through `<use>` has one copy per place it is rendered.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Copies {
    drawn: usize,
    omitted: usize,
}

/// Where a supplied picture's stand-in sits in the SVG.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct StandIn {
    /// Inside a `<marker>`: usvg strips ids there, so the picture can never be placed.
    in_marker: bool,
}

/// The blank SVG standing in for picture `id`, of the picture's pixel size: one invisible path
/// carrying the id. `rasterPicturePlaceholderHref` builds the same string.
pub(super) fn placeholder_href(width: u32, height: u32, id: &str) -> String {
    format!(
        "{PLACEHOLDER_HREF_START}{width}{PLACEHOLDER_HREF_MIDDLE}{height}{PLACEHOLDER_HREF_ID}{id}{PLACEHOLDER_HREF_END}"
    )
}

/// Whether `href` is exactly the stand-in `placeholder_href` writes for picture `id`, of any size.
fn is_placeholder_href(href: &str, id: &str) -> bool {
    let is_side = |digits: &str| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit());
    href.strip_prefix(PLACEHOLDER_HREF_START)
        .and_then(|rest| rest.strip_suffix(PLACEHOLDER_HREF_END))
        .and_then(|rest| rest.strip_suffix(id))
        .and_then(|rest| rest.strip_suffix(PLACEHOLDER_HREF_ID))
        .and_then(|rest| rest.split_once(PLACEHOLDER_HREF_MIDDLE))
        .is_some_and(|(width, height)| is_side(width) && is_side(height))
}

/// The picture id a stand-in names: the id of the only node of its SVG, an invisible path. usvg
/// parses every `<image>`'s href afresh into that image's own tree (`Tree::from_data_nested`), so
/// the id survives on every copy, whatever usvg did to the ids of the copied elements themselves.
fn stand_in_picture_id(image: &usvg::Image) -> Option<&str> {
    let usvg::ImageKind::SVG(tree) = image.kind() else {
        return None;
    };
    match tree.root().children() {
        [usvg::Node::Path(path)] if !path.is_visible() => Some(path.id()),
        _ => None,
    }
}

/// The href of an SVG `<image>` that has exactly one (in any namespace usvg reads).
fn single_image_href<'a>(node: &usvg::roxmltree::Node<'a, '_>) -> Option<&'a str> {
    if !node.is_element()
        || node.tag_name().name() != "image"
        || node.tag_name().namespace() != Some(SVG_NAMESPACE)
    {
        return None;
    }
    let mut hrefs = node.attributes().filter(|attr| attr.name() == "href");
    let href = hrefs.next()?;
    hrefs.next().is_none().then_some(href.value())
}

/// A picture stand-in whose pixels were not supplied: a generated id and the stand-in href for
/// that id. An image whose id merely starts like a generated one is judged by its href like any
/// other.
pub(super) fn is_unsupplied_stand_in(node: &usvg::roxmltree::Node<'_, '_>) -> bool {
    node.attribute("id").is_some_and(|id| {
        id.starts_with(PICTURE_ID_PREFIX)
            && single_image_href(node).is_some_and(|href| is_placeholder_href(href, id))
    })
}

/// A PNG picture the webview left out because the export had more than `MAX_PICTURES`.
pub(super) fn is_over_count_stand_in(node: &usvg::roxmltree::Node<'_, '_>) -> bool {
    single_image_href(node) == Some(OVER_COUNT_HREF)
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

        // serde has already deserialized the IPC request (its base64 strings included) by the time
        // this runs; the webview is the app's own caller. These checks bound only what follows:
        // every id, size and the per-export total first, then the payload lengths, and only then
        // the unpacking, so an oversized request allocates no pixel buffers.
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
                    // `decode` takes the string by value, so each picture's base64 is freed as
                    // soon as it is unpacked, and the decoded buffer becomes the pixmap in place.
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
            Supplied::Decoded(pixmap) => placeholder_href(pixmap.width(), pixmap.height(), id),
            Supplied::Refused(_) => placeholder_href(1, 1, id),
        })
    }

    /// The supplied pictures whose stand-in is in the SVG: exactly one SVG `<image>` with the id
    /// and a single href equal to the expected stand-in, each with where it sits.
    pub(super) fn find_stand_ins(
        &self,
        document: &usvg::roxmltree::Document<'_>,
    ) -> HashMap<String, StandIn> {
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
                let href = single_image_href(node)?;
                (href == self.expected_href(id)?).then(|| {
                    let in_marker = node.ancestors().any(|ancestor| {
                        ancestor.tag_name().name() == "marker"
                            && ancestor.tag_name().namespace() == Some(SVG_NAMESPACE)
                    });
                    (id.to_string(), StandIn { in_marker })
                })
            })
            .collect()
    }

    /// Renders `tree` as `resvg::render` would, plus every placeable decoded picture.
    /// Returns, per picture id, how many rendered copies were drawn and how many left out.
    pub(super) fn render(
        &self,
        tree: &usvg::Tree,
        stand_ins: &HashMap<String, StandIn>,
        transform: tiny_skia::Transform,
        canvas: &mut tiny_skia::PixmapMut<'_>,
    ) -> HashMap<String, Copies> {
        let pixmaps: HashMap<&str, &tiny_skia::Pixmap> = self
            .pictures
            .iter()
            .filter_map(|(id, supplied)| match supplied {
                Supplied::Decoded(pixmap)
                    if stand_ins
                        .get(id)
                        .is_some_and(|stand_in| !stand_in.in_marker) =>
                {
                    Some((id.as_str(), pixmap))
                }
                _ => None,
            })
            .collect();
        if pixmaps.is_empty() {
            resvg::render(tree, transform, canvas);
            return HashMap::new();
        }

        let mut renderer = PictureRenderer {
            pixmaps: &pixmaps,
            copies: Vec::new(),
        };
        let root = tree.root();
        renderer.render_children(root, None, transform, canvas);
        // Pictures used by patterns, masks, clip paths or filter images are drawn there by resvg,
        // which has no pixels for them; report them rather than show them only in some places.
        renderer.mark_subroot_pictures(root, false);
        // Copies made by reference have lost their ids, so none of the above saw them.
        renderer.copies.extend(
            find_copies_by_reference(root, &pixmaps)
                .into_iter()
                .map(|id| (id.to_string(), false)),
        );
        let mut copies: HashMap<String, Copies> = HashMap::new();
        for (id, drawn) in renderer.copies {
            let entry = copies.entry(id).or_default();
            if drawn {
                entry.drawn += 1;
            } else {
                entry.omitted += 1;
            }
        }
        copies
    }

    /// One warning per reason, counting the pictures in the SVG that were not drawn, or drawn
    /// only in some of the places they are used. `over_count` is the number of stand-ins the
    /// webview left out for exceeding `MAX_PICTURES`, which have no entry in the request.
    pub(super) fn omission_warnings(
        &self,
        stand_ins: &HashMap<String, StandIn>,
        copies: &HashMap<String, Copies>,
        over_count: usize,
        label: &str,
    ) -> Vec<RasterExportWarning> {
        let mut counts: HashMap<Omission, usize> = HashMap::new();
        if over_count > 0 {
            counts.insert(Omission::OverCount, over_count);
        }
        for (id, supplied) in &self.pictures {
            let Some(&StandIn { in_marker, .. }) = stand_ins.get(id) else {
                continue;
            };
            let omission = match supplied {
                Supplied::Refused(refusal) => Omission::Refused(*refusal),
                Supplied::Decoded(_) => {
                    let Copies { drawn, omitted } = copies.get(id).copied().unwrap_or_default();
                    if in_marker || drawn == 0 {
                        Omission::Unplaceable
                    } else if omitted > 0 {
                        Omission::SomeCopies
                    } else {
                        continue;
                    }
                }
            };
            *counts.entry(omission).or_default() += 1;
        }
        [
            Omission::Refused(PictureRefusal::TooLarge),
            Omission::Refused(PictureRefusal::OverBudget),
            Omission::Refused(PictureRefusal::DecodeFailed),
            Omission::OverCount,
            Omission::Unplaceable,
            Omission::SomeCopies,
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
    let (pictures, were, them, its) = if count == 1 {
        ("1 picture".to_string(), "was", "it", "its")
    } else {
        (format!("{count} pictures"), "were", "them", "their")
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
        Omission::OverCount => format!(
            "{label} export: {pictures} {were} not included because this export has more than {MAX_PICTURES} pictures; export SVG or PDF to include {them}."
        ),
        Omission::Unplaceable => format!(
            "{label} export: {pictures} inside a mask, filter, blend mode, pattern or marker {were} not included; export SVG or PDF to include {them}."
        ),
        Omission::SomeCopies => format!(
            "{label} export: {pictures} {were} included, but not {its} copies inside a mask, filter, blend mode or pattern; export SVG or PDF to include every copy."
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

/// The pictures in `pixmaps` with at least one copy made by reference: through `<use>` or
/// `<feImage>`, directly or inside cloned content. Such copies are never drawn. usvg 0.47 clones
/// a `<use>` target with every `id` ignored (svgtree `parse_svg_use_element`), and moves an
/// `<feImage>` target's own, empty, image id onto its wrapper (filter `convert_image_inner`), so
/// a copy has no picture wrapper; its stand-in still names the picture (`stand_in_picture_id`).
/// A link that clones nothing (`<a href>`) leaves no such image, and an image whose stand-in names
/// no supplied picture is never counted.
///
/// One visit per node: a clip path, mask, filter or pattern shared by several elements is entered
/// once (it is the same `Arc`, and its copies are the same whichever element uses it), and the
/// trees of SVG images are not entered, as no reference reaches inside an image. The result holds
/// at most one entry per picture.
fn find_copies_by_reference<'p>(
    root: &usvg::Group,
    pixmaps: &HashMap<&'p str, &tiny_skia::Pixmap>,
) -> HashSet<&'p str> {
    let mut search = CopySearch {
        pixmaps,
        entered: HashSet::new(),
        omitted: HashSet::new(),
    };
    search.visit(root, false);
    search.omitted
}

struct CopySearch<'p, 'm> {
    pixmaps: &'m HashMap<&'p str, &'m tiny_skia::Pixmap>,
    /// Subroots already searched, by address; the tree outlives the search.
    entered: HashSet<*const usvg::Group>,
    omitted: HashSet<&'p str>,
}

impl CopySearch<'_, '_> {
    /// `in_picture`: inside a picture wrapper, whose image is the picture itself, not a copy.
    fn visit(&mut self, parent: &usvg::Group, in_picture: bool) {
        for node in parent.children() {
            match node {
                usvg::Node::Group(group) => {
                    let in_picture = in_picture || self.pixmaps.contains_key(group.id());
                    self.visit(group, in_picture);
                }
                usvg::Node::Image(image) => {
                    if !in_picture {
                        let picture = stand_in_picture_id(image)
                            .and_then(|id| self.pixmaps.get_key_value(id));
                        if let Some((&id, _)) = picture {
                            self.omitted.insert(id);
                        }
                    }
                    // Its own tree is a stand-in or an SVG picture, and no reference reaches in.
                    continue;
                }
                usvg::Node::Path(_) | usvg::Node::Text(_) => {}
            }
            node.subroots(|subroot| {
                if self.entered.insert(std::ptr::from_ref(subroot)) {
                    self.visit(subroot, false);
                }
            });
        }
    }
}

struct PictureRenderer<'p> {
    pixmaps: &'p HashMap<&'p str, &'p tiny_skia::Pixmap>,
    /// One entry per rendered copy of a picture, in drawing order: its id and whether it was drawn.
    copies: Vec<(String, bool)>,
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
                        self.copies.push((id.to_string(), true));
                        draw_picture(image, pixmap, transform, canvas);
                    }
                    None => render_with_resvg(node, transform, canvas),
                }
            }
            _ => render_plain_node(node, transform, canvas),
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
        if unsupported_effect {
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
        let first_copy = self.copies.len();
        self.render_children(group, picture, layer_transform, &mut layer.as_mut());
        if let Some(clip) = group.clip_path() {
            if apply_clip(clip, layer_transform, &mut layer).is_none() {
                // The layer is discarded, so the copies drawn into it are not on the canvas.
                self.copies.truncate(first_copy);
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

    /// Records every picture copy in `group` (and the enclosing `picture`) as drawn — used when
    /// nothing of the group can be visible — or as impossible to place exactly.
    fn mark(&mut self, group: &usvg::Group, picture: Option<&str>, drawn: bool) {
        let mut ids: Vec<String> = picture.map(str::to_string).into_iter().collect();
        self.collect_picture_ids(group, &mut ids);
        self.copies.extend(ids.into_iter().map(|id| (id, drawn)));
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
                    self.copies.push((group.id().to_string(), false));
                }
                self.mark_subroot_pictures(group, in_subroot);
            }
            node.subroots(|subroot| self.mark_subroot_pictures(subroot, true));
        }
    }
}

/// Draws a node that holds no supplied picture exactly as `resvg::render` would.
fn render_plain_node(
    node: &usvg::Node,
    transform: tiny_skia::Transform,
    canvas: &mut tiny_skia::PixmapMut<'_>,
) {
    match node {
        // `resvg::render_node` skips a node without a layer box, which would lose a bare
        // horizontal or vertical stroked line; it is stroked here instead.
        usvg::Node::Path(path) if node.abs_layer_bounding_box().is_none() => {
            stroke_degenerate_path(path, transform, canvas);
        }
        _ => render_with_resvg(node, transform, canvas),
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
/// this is resvg's `stroke_path` (resvg 0.47, src/path.rs) for every paint: plain colour,
/// gradients, and patterns, whose tile is drawn with `render_plain_node` as resvg draws it.
fn stroke_degenerate_path(
    path: &usvg::Path,
    transform: tiny_skia::Transform,
    canvas: &mut tiny_skia::PixmapMut<'_>,
) {
    let Some(stroke) = path.stroke().filter(|_| path.is_visible()) else {
        return;
    };
    let pattern_pixmap;
    let mut paint = tiny_skia::Paint::default();
    match stroke.paint() {
        usvg::Paint::Color(color) => {
            paint.set_color_rgba8(color.red, color.green, color.blue, stroke.opacity().to_u8());
        }
        usvg::Paint::LinearGradient(gradient) => {
            let Some(shader) = linear_gradient_shader(gradient, stroke.opacity()) else {
                return;
            };
            paint.shader = shader;
        }
        usvg::Paint::RadialGradient(gradient) => {
            let Some(shader) = radial_gradient_shader(gradient, stroke.opacity()) else {
                return;
            };
            paint.shader = shader;
        }
        usvg::Paint::Pattern(pattern) => {
            let Some((tile, tile_transform)) = render_pattern_tile(pattern, transform) else {
                return;
            };
            pattern_pixmap = tile;
            paint.shader = tiny_skia::Pattern::new(
                pattern_pixmap.as_ref(),
                tiny_skia::SpreadMode::Repeat,
                tiny_skia::FilterQuality::Bicubic,
                stroke.opacity().get(),
                tile_transform,
            );
        }
    }
    paint.anti_alias = path.rendering_mode().use_shape_antialiasing();
    canvas.stroke_path(path.data(), &paint, &stroke.to_tiny_skia(), transform, None);
}

// resvg's paint-server conversion (resvg 0.47, src/path.rs), which is private to resvg.

fn linear_gradient_shader(
    gradient: &usvg::LinearGradient,
    opacity: usvg::Opacity,
) -> Option<tiny_skia::Shader<'static>> {
    let (mode, stops) = gradient_stops(gradient, opacity);
    tiny_skia::LinearGradient::new(
        (gradient.x1(), gradient.y1()).into(),
        (gradient.x2(), gradient.y2()).into(),
        stops,
        mode,
        gradient.transform(),
    )
}

fn radial_gradient_shader(
    gradient: &usvg::RadialGradient,
    opacity: usvg::Opacity,
) -> Option<tiny_skia::Shader<'static>> {
    let (mode, stops) = gradient_stops(gradient, opacity);
    tiny_skia::RadialGradient::new(
        (gradient.fx(), gradient.fy()).into(),
        gradient.fr().get(),
        (gradient.cx(), gradient.cy()).into(),
        gradient.r().get(),
        stops,
        mode,
        gradient.transform(),
    )
}

fn gradient_stops(
    gradient: &usvg::BaseGradient,
    opacity: usvg::Opacity,
) -> (tiny_skia::SpreadMode, Vec<tiny_skia::GradientStop>) {
    let mode = match gradient.spread_method() {
        usvg::SpreadMethod::Pad => tiny_skia::SpreadMode::Pad,
        usvg::SpreadMethod::Reflect => tiny_skia::SpreadMode::Reflect,
        usvg::SpreadMethod::Repeat => tiny_skia::SpreadMode::Repeat,
    };
    let stops = gradient
        .stops()
        .iter()
        .map(|stop| {
            let color = tiny_skia::Color::from_rgba8(
                stop.color().red,
                stop.color().green,
                stop.color().blue,
                (stop.opacity() * opacity).to_u8(),
            );
            tiny_skia::GradientStop::new(stop.offset().get(), color)
        })
        .collect();
    (mode, stops)
}

fn render_pattern_tile(
    pattern: &usvg::Pattern,
    transform: tiny_skia::Transform,
) -> Option<(tiny_skia::Pixmap, tiny_skia::Transform)> {
    let (sx, sy) = transform.pre_concat(pattern.transform()).get_scale();
    let rect = pattern.rect();
    let size = tiny_skia::IntSize::from_wh(
        (rect.width() * sx).round() as u32,
        (rect.height() * sy).round() as u32,
    )?;
    let mut tile = tiny_skia::Pixmap::new(size.width(), size.height())?;
    let tile_scale = tiny_skia::Transform::from_scale(sx, sy);
    for node in pattern.root().children() {
        render_plain_node(node, tile_scale, &mut tile.as_mut());
    }
    let tile_transform = pattern
        .transform()
        .pre_translate(rect.x(), rect.y())
        .pre_scale(1.0 / sx, 1.0 / sy);
    Some((tile, tile_transform))
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

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "chemdraft-raster-picture-0";

    fn parse(body: &str) -> usvg::Tree {
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">{body}</svg>"#
        );
        usvg::Tree::from_str(&svg, &usvg::Options::default()).expect("parse the test SVG")
    }

    #[test]
    fn a_stand_in_names_its_picture_in_its_own_tree() {
        let href = placeholder_href(144, 72, ID);
        // `rasterPicturePlaceholderHref(144, 72, "chemdraft-raster-picture-0")` writes the same.
        assert_eq!(
            href,
            "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='144'%20height='72'%3E%3Cpath%20id='chemdraft-raster-picture-0'%20d='M0%200H1V1H0Z'%20fill='none'/%3E%3C/svg%3E"
        );
        assert!(is_placeholder_href(&href, ID));
        for other_id in ["chemdraft-raster-picture-1", "picture-0", ""] {
            assert!(!is_placeholder_href(&href, other_id), "{other_id}");
        }
        let unmarked =
            "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='144'%20height='72'/%3E";
        assert!(!is_placeholder_href(unmarked, ID));

        // usvg keeps the path's id inside the image's own tree, and sizes the image by the SVG.
        let tree = parse(&format!(
            r#"<image width="10" height="5" href="{href}"/><image width="10" height="5" href="{unmarked}"/>"#
        ));
        let images: Vec<&usvg::Image> = tree
            .root()
            .children()
            .iter()
            .filter_map(|node| match node {
                usvg::Node::Group(group) => match group.children() {
                    [usvg::Node::Image(image)] => Some(image.as_ref()),
                    _ => None,
                },
                _ => None,
            })
            .collect();
        assert_eq!(images.len(), 2);
        assert_eq!(stand_in_picture_id(images[0]), Some(ID));
        assert_eq!(
            (images[0].size().width(), images[0].size().height()),
            (144.0, 72.0)
        );
        assert_eq!(stand_in_picture_id(images[1]), None);
    }

    #[test]
    fn copies_by_reference_are_found_in_one_pass_with_one_entry_per_picture() {
        let ids: Vec<String> = (0..MAX_PICTURES)
            .map(|index| format!("{PICTURE_ID_PREFIX}{index}"))
            .collect();
        // A mask that copies every picture, shared (one `Arc`) by every masked group below.
        let mut body = String::from(
            r#"<defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="10" height="10">"#,
        );
        for id in &ids {
            body.push_str(&format!(r##"<use href="#{id}"/>"##));
        }
        body.push_str("</mask></defs>");
        for id in &ids {
            body.push_str(&format!(
                r#"<image id="{id}" width="1" height="1" href="{}"/>"#,
                placeholder_href(1, 1, id)
            ));
        }
        // Blank SVG images of every picture's size, which are no copies of anything.
        let blank =
            "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='1'%20height='1'/%3E";
        for _ in 0..1000 {
            body.push_str(&format!(
                r#"<image width="1" height="1" href="{blank}"/><g mask="url(#m)"><rect width="1" height="1"/></g>"#
            ));
        }
        let tree = parse(&body);
        let pixmap = tiny_skia::Pixmap::new(1, 1).expect("a 1 × 1 pixmap");
        let pixmaps: HashMap<&str, &tiny_skia::Pixmap> =
            ids.iter().map(|id| (id.as_str(), &pixmap)).collect();

        let mut search = CopySearch {
            pixmaps: &pixmaps,
            entered: HashSet::new(),
            omitted: HashSet::new(),
        };
        search.visit(tree.root(), false);
        // Every picture once, though 1000 groups draw its copy, and the shared mask entered once:
        // the only allocations are these two sets, bounded by the pictures and distinct subroots.
        assert_eq!(search.omitted.len(), MAX_PICTURES);
        assert!(ids.iter().all(|id| search.omitted.contains(id.as_str())));
        assert_eq!(search.entered.len(), 1);

        // Without the mask's copies, nothing is a copy: the pictures' own images are in their
        // wrappers, and the blank images name no picture.
        let unused = body.replace(r#" mask="url(#m)""#, "");
        let tree = parse(&unused);
        assert!(find_copies_by_reference(tree.root(), &pixmaps).is_empty());
    }
}
