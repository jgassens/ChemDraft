//! Hold a palette where ChemDraft put it while the window manager maps it again.
//!
//! An X11 window manager manages a window afresh every time it is mapped. KWin (KDE Plasma,
//! XWayland included) then keeps the whole frame inside the work area (`keepInArea` in its manage
//! step), even for a window that carries USPosition (utility_window::pin_content_fit_frame). So a
//! palette the user had left overhanging a screen edge jumped fully onto the screen whenever it was
//! shown again: after a Save As or Open dialog had hidden it (utility_suspension), or when it was
//! reopened from View ▸ Toolbars. The Moved event then saved that position as the user's (GitHub
//! #304; Linux VM retest: Main moved from 450,315 to 369,315, 1680 - 1311, on a 1680-px screen).
//! None of ChemDraft's own clamps move a palette whose title strip is reachable.
//!
//! Before such a map ChemDraft pins the palette at the position it must keep. For a short time
//! afterwards a Moved event that lands exactly where that clamp would put the pinned frame (pushed
//! fully into the one work area it overlaps most, on the axis that overhung, the other axis
//! unchanged) is the window manager's placement: it is not saved, and the palette is moved back with
//! `_NET_MOVERESIZE_WINDOW` (utility_window::move_mapped), which KWin handles as a pager's request
//! and so does not pull back into the work area. A Moved event anywhere else is a real move (a drag,
//! a window manager move the user asked for such as Alt-drag): it ends the pin and is saved as usual.
//! A move ChemDraft makes itself re-targets the pin; the earlier target is then superseded, and a
//! Moved event still on its way to it is ignored. A drag the user starts ends the pin, and a move
//! back to a palette's pre-hide position scheduled before the drag is dropped. A palette
//! shown again while already at its pin's clamp (a move back lost when it was hidden) is moved back
//! at once, since the map may report no move. A palette closed while pinned saves its pin, and a
//! reopen of the same hidden window pins that position rather than the clamp it may still sit at.
//! Only Linux X11/XWayland pins palettes (utility_window::map_replaces_position); elsewhere no pin
//! exists and every Moved event is handled as before.
//!
//! A pin's clock starts again at the first look that sees its palette mapped, and those looks go
//! on until the pin ends: KWin can report its placement long after the show was requested (Linux
//! VM, 1.2.3: Main pinned at -143,159 was clamped to 0,159 after a 1.5-s pin had expired, and
//! 0,159 was saved).

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// How long a move to the window manager's clamp counts as its placement: from the first look that
/// sees the palette mapped ([`MapPins::mapped_look`]), or from the pin while no look has. A busy
/// main thread can hand ChemDraft the window manager's Moved event over a second after the map.
const PIN_DURATION: Duration = Duration::from_secs(5);
/// How long a pin that expired by itself is remembered, only to log a Moved event that arrives
/// just after it ([`MapPins::expired_pin`]).
const EXPIRED_PIN_MEMORY: Duration = Duration::from_secs(10);
/// How many times a pin moves the palette back before it leaves the window manager's position.
const MAX_CORRECTIONS: u8 = 2;
/// Pixels of slack for a window manager rounding a position.
const TOLERANCE: i32 = 2;
/// How often a palette just shown again is looked at for a frame already at its pin's clamp.
/// Only Linux waits for the map on the GTK main loop.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) const AFTER_MAP_INTERVAL: Duration = Duration::from_millis(50);
/// How long to wait for that palette to be mapped before giving up on the look.
pub(crate) const AFTER_MAP_WAIT: Duration = Duration::from_millis(500);

/// A physical position or frame size, in pixels.
type Pixels = (i32, i32);

/// A target ChemDraft moved a pinned palette away from, with every outer frame size it had there
/// (empty when none was known).
#[derive(Debug, Clone)]
struct SupersededTarget {
    position: Pixels,
    sizes: Vec<Pixels>,
}

/// A palette closed while pinned: the position saved for it, and every outer frame size its pin
/// target had (empty when the saved position was not the target). A reopen of the same hidden
/// window that still sits at the clamp of any of those frames starts from `position`: a content
/// fit in place may have shrunk the frame after the window manager clamped the one it mapped.
#[derive(Debug, Clone)]
pub(crate) struct ClosedPin {
    pub(crate) position: Pixels,
    sizes: Vec<Pixels>,
}

impl From<Pixels> for ClosedPin {
    fn from(position: Pixels) -> Self {
        Self {
            position,
            sizes: Vec::new(),
        }
    }
}

/// A monitor's work area, in the same physical pixels as the outer positions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WorkArea {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: i32,
    pub(crate) height: i32,
}

/// What a Moved event is judged against: the palette's outer frame size, the current work areas,
/// and whether the palette's title strip could be grabbed at a given outer position.
pub(crate) struct Layout<'a> {
    pub(crate) size: (i32, i32),
    pub(crate) work_areas: &'a [WorkArea],
    pub(crate) title_reachable: &'a dyn Fn((i32, i32)) -> bool,
}

/// What a Moved event of a palette means for its pin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MovedDecision {
    /// Not pinned (or the pin expired): handle the move as usual.
    Unpinned,
    /// The palette is at its pin: handle the move as usual.
    AtPin,
    /// The window manager clamped it as it mapped it: do not save it, and move it back here.
    Reassert((i32, i32)),
    /// Still clamped after the moves back: do not save it, and leave it to the window manager.
    Hold((i32, i32)),
    /// A move to a target ChemDraft has since replaced (a correction or clamp still on its way):
    /// do not save it and do not move it; ChemDraft's newer move follows.
    Superseded,
    /// Not where the window manager's clamp would put it, so the user moved it: the pin is gone,
    /// handle the move as usual.
    Moved,
    /// The window manager clamped it, but the pinned position's title strip can no longer be
    /// grabbed on the current monitors: the pin is gone, handle the move as usual.
    Unreachable((i32, i32)),
}

#[derive(Debug, Clone)]
struct Pin {
    position: (i32, i32),
    /// The outer frame size last seen while `position` was the target, if any was.
    size: Option<(i32, i32)>,
    /// Every outer frame size seen while `position` was the target, `size` included unless it was
    /// only carried over from an earlier target. A content fit in place can shrink the frame
    /// before the window manager's clamp of the frame it mapped is handled: that clamp is still
    /// predicted with the size it was made for, not only with the size the frame has now.
    sizes: Vec<(i32, i32)>,
    until: Instant,
    /// Whether a look has seen the palette mapped, which restarted `until`
    /// ([`MapPins::mapped_look`]).
    mapped: bool,
    corrections: u8,
    /// The clamp position a move back was last sent for, by a Moved event or a look: a look that
    /// finds the frame still there does not send another one (the first is on its way).
    answered: Option<Pixels>,
    /// Earlier targets ChemDraft moved the palette away from while it was pinned, each with the
    /// frame size it had then: a late clamp of an old target is predicted with the old frame, not
    /// with the size a content fit has given it since.
    superseded: Vec<SupersededTarget>,
}

/// A pin that expired by itself: its target and when it expired.
#[derive(Debug, Clone, Copy)]
struct ExpiredPin {
    position: Pixels,
    at: Instant,
}

/// Where a reported position lies relative to a pin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Spot {
    /// At the pin target, within the rounding slack.
    Target,
    /// Where the window manager's map clamp puts the pinned frame.
    Clamp,
    /// At a target ChemDraft has since replaced, or at that target's clamp.
    Superseded,
    /// Anywhere else: a real move.
    Elsewhere,
}

/// Pinned palettes by window label, with physical outer positions.
#[derive(Default)]
pub(crate) struct MapPins {
    pins: HashMap<String, Pin>,
    /// Palettes closed while pinned, with the position saved for them and the frame sizes their
    /// target had: a reopen of the same hidden window pins that position, not the clamp the hidden
    /// window may still sit at.
    closed: HashMap<String, ClosedPin>,
    /// Pins that expired by themselves in the last [`EXPIRED_PIN_MEMORY`], for the diagnostic.
    expired: HashMap<String, ExpiredPin>,
    /// When the user last started dragging each palette ([`Self::drag_started`]): a move back
    /// ChemDraft scheduled before then must not undo the drag. One entry per palette label.
    drags: HashMap<String, Instant>,
}

fn near(a: (i32, i32), b: (i32, i32)) -> bool {
    (a.0 - b.0).abs() <= TOLERANCE && (a.1 - b.1).abs() <= TOLERANCE
}

fn distance(a: (i32, i32), b: (i32, i32)) -> i64 {
    (i64::from(a.0) - i64::from(b.0)).abs() + (i64::from(a.1) - i64::from(b.1)).abs()
}

/// Where keeping a frame of `length` starting at `start` inside `[area_start, area_start +
/// area_length)` puts it: unchanged when it does not overhang, else pushed in from the far edge and
/// then the near one, as KWin's `keepInArea` does (a frame longer than the area starts at its edge).
fn clamp_axis(start: i32, length: i32, area_start: i32, area_length: i32) -> i32 {
    let area_end = area_start.saturating_add(area_length);
    if start >= area_start && start.saturating_add(length) <= area_end {
        return start;
    }
    start.min(area_end.saturating_sub(length)).max(area_start)
}

/// How many pixels of `[start, start + length)` lie in `[area_start, area_start + area_length)`.
fn overlap_length(start: i32, length: i32, area_start: i32, area_length: i32) -> i64 {
    let end = i64::from(start) + i64::from(length);
    let area_end = i64::from(area_start) + i64::from(area_length);
    (end.min(area_end) - i64::from(start).max(i64::from(area_start))).max(0)
}

/// The work area a window manager keeps a frame at `position` inside as it maps it: the one the
/// frame overlaps most (the first of equal ones). KWin clamps into the area of the one output the
/// window is placed on, not into every area the frame touches.
fn placement_area(
    position: (i32, i32),
    size: (i32, i32),
    work_areas: &[WorkArea],
) -> Option<&WorkArea> {
    let mut best: Option<(&WorkArea, i64)> = None;
    for area in work_areas {
        let overlap = overlap_length(position.0, size.0, area.x, area.width)
            * overlap_length(position.1, size.1, area.y, area.height);
        let better = match best {
            Some((_, most)) => overlap > most,
            None => true,
        };
        if overlap > 0 && better {
            best = Some((area, overlap));
        }
    }
    best.map(|(area, _)| area)
}

/// Where a window manager keeping a frame of `size` at `target` inside its placement work area
/// puts it, when that moves it at all. The clamp moves only the axis that overhung that area.
fn predicted_clamp(
    target: (i32, i32),
    size: (i32, i32),
    work_areas: &[WorkArea],
) -> Option<(i32, i32)> {
    let area = placement_area(target, size, work_areas)?;
    let clamp = (
        clamp_axis(target.0, size.0, area.x, area.width),
        clamp_axis(target.1, size.1, area.y, area.height),
    );
    (clamp != target).then_some(clamp)
}

/// Whether `position` is where a window manager's map clamp puts a frame of `size` pinned at
/// `target`. A 1-2 px overhang puts the clamp within the target's rounding slack, so a position
/// near both counts as the clamp when it is nearer the clamp: an exact clamp is not the target.
fn is_clamp_of(
    target: (i32, i32),
    size: (i32, i32),
    position: (i32, i32),
    work_areas: &[WorkArea],
) -> bool {
    predicted_clamp(target, size, work_areas).is_some_and(|clamp| {
        near(position, clamp)
            && (!near(position, target) || distance(position, clamp) < distance(position, target))
    })
}

impl Pin {
    /// Remember that the target's frame has had `size`.
    fn record_size(&mut self, size: (i32, i32)) {
        self.size = Some(size);
        if !self.sizes.contains(&size) {
            self.sizes.push(size);
        }
    }

    fn spot(&self, position: (i32, i32), layout: &Layout<'_>) -> Spot {
        let clamp = std::iter::once(layout.size)
            .chain(self.sizes.iter().copied())
            .any(|size| is_clamp_of(self.position, size, position, layout.work_areas));
        if clamp {
            return Spot::Clamp;
        }
        if near(position, self.position) {
            return Spot::Target;
        }
        let superseded = self.superseded.iter().any(|old| {
            if near(position, old.position) {
                return true;
            }
            if old.sizes.is_empty() {
                return is_clamp_of(old.position, layout.size, position, layout.work_areas);
            }
            old.sizes
                .iter()
                .any(|size| is_clamp_of(old.position, *size, position, layout.work_areas))
        });
        if superseded {
            Spot::Superseded
        } else {
            Spot::Elsewhere
        }
    }
}

impl MapPins {
    fn prune(&mut self, now: Instant) {
        let expired = &mut self.expired;
        self.pins.retain(|label, pin| {
            let live = now < pin.until;
            if !live {
                expired.insert(
                    label.clone(),
                    ExpiredPin {
                        position: pin.position,
                        at: pin.until,
                    },
                );
            }
            live
        });
        self.expired
            .retain(|_, record| now.saturating_duration_since(record.at) < EXPIRED_PIN_MEMORY);
    }

    /// Hold `label` at `target` through the map that is about to happen. `size` is its outer
    /// frame, when known.
    pub(crate) fn pin(
        &mut self,
        label: &str,
        target: impl Into<ClosedPin>,
        size: Option<(i32, i32)>,
        now: Instant,
    ) {
        self.prune(now);
        self.closed.remove(label);
        self.expired.remove(label);
        let ClosedPin { position, sizes } = target.into();
        let mut pin = Pin {
            position,
            size: None,
            sizes,
            until: now + PIN_DURATION,
            mapped: false,
            corrections: 0,
            answered: None,
            superseded: Vec::new(),
        };
        if let Some(size) = size {
            pin.record_size(size);
        }
        self.pins.insert(label.to_string(), pin);
    }

    /// ChemDraft moved a pinned palette itself (content fit, off-screen recovery): hold it there.
    /// `size` is the outer frame it moved the palette with, when known. The old target is
    /// superseded, with every frame size it had: a correction or clamp still on its way to it is
    /// ignored, and the new target gets its own moves back. Every target keeps its own sizes, so a
    /// target replaced before any Moved event reached it is still judged with its own frames.
    pub(crate) fn moved_by_chemdraft(
        &mut self,
        label: &str,
        position: (i32, i32),
        size: Option<(i32, i32)>,
        now: Instant,
    ) {
        self.prune(now);
        if let Some(pin) = self.pins.get_mut(label) {
            if pin.position != position {
                let old = std::mem::replace(&mut pin.position, position);
                let old_size = pin.size;
                let mut old_sizes = std::mem::replace(&mut pin.sizes, size.into_iter().collect());
                if old_sizes.is_empty() {
                    // Only a size carried over from an earlier target, if that.
                    old_sizes.extend(old_size);
                }
                pin.size = size.or(old_size);
                pin.superseded.push(SupersededTarget {
                    position: old,
                    sizes: old_sizes,
                });
                pin.corrections = 0;
                pin.answered = None;
            } else if let Some(size) = size {
                pin.record_size(size);
            }
        }
    }

    /// ChemDraft resized a pinned palette without moving it (a content fit in place): the target
    /// stays, but it now has this outer frame as well, so a later retarget archives it with the
    /// frames it really had. The target is left alone even when the palette sits at its clamp:
    /// only the size changed. The frames it had before stay known, so a clamp the window manager
    /// made of the earlier frame, reported after the resize, is still recognised as its clamp.
    pub(crate) fn resized_by_chemdraft(&mut self, label: &str, size: (i32, i32), now: Instant) {
        self.prune(now);
        if let Some(pin) = self.pins.get_mut(label) {
            pin.record_size(size);
        }
    }

    /// The user is dragging the palette, or its window is gone: every later move is not a map's.
    pub(crate) fn forget(&mut self, label: &str) {
        self.pins.remove(label);
        self.closed.remove(label);
        self.expired.remove(label);
    }

    /// The user started dragging `label` at `now`: its pin ends ([`Self::forget`]), and a move back
    /// to its pre-hide position scheduled before now is dropped ([`Self::move_back_after_restore`]).
    pub(crate) fn drag_started(&mut self, label: &str, now: Instant) {
        self.forget(label);
        self.drags.insert(label.to_string(), now);
    }

    /// A palette restored after a dialog at `requested` was placed away from its pre-hide
    /// `position` by the window manager: whether ChemDraft may move it back there now. Not when the
    /// user has started a drag since `requested`: that move is the user's and is never undone.
    /// Otherwise the pin, if still live, is re-targeted to `position` ([`Self::moved_by_chemdraft`])
    /// so the Moved event of the move back is held there, and the move goes ahead. A pin a Moved
    /// event ended does not stop it: the window manager's own placement (centered, cascaded) ends
    /// the pin too, and undoing that placement is what the move back is for (GitHub #304). Only
    /// Linux schedules such a move back.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) fn move_back_after_restore(
        &mut self,
        label: &str,
        position: Pixels,
        requested: Instant,
        now: Instant,
    ) -> bool {
        if self
            .drags
            .get(label)
            .is_some_and(|dragged| *dragged >= requested)
        {
            return false;
        }
        self.moved_by_chemdraft(label, position, None, now);
        true
    }

    /// The palette is being closed: its pin ends. `kept` is the position saved for it when it was
    /// pinned as the close began (the caller's one look at the pin, so an expiry during the close
    /// changes nothing); a reopen of the same hidden window then starts from `kept`
    /// ([`Self::reopen_position`]). `None` leaves no record. When `kept` is the pin's target, the
    /// record keeps every frame size the target had, so the clamp of the frame it was mapped with
    /// is still recognised after a content fit has resized it.
    pub(crate) fn close(&mut self, label: &str, kept: Option<(i32, i32)>) {
        self.expired.remove(label);
        let pin = self.pins.remove(label);
        match kept {
            Some(kept) => {
                let sizes = pin
                    .filter(|pin| near(pin.position, kept))
                    .map(|pin| pin.sizes)
                    .unwrap_or_default();
                self.closed.insert(
                    label.to_string(),
                    ClosedPin {
                        position: kept,
                        sizes,
                    },
                );
            }
            None => {
                self.closed.remove(label);
            }
        }
    }

    /// Where to pin a palette closed while pinned as it is shown again: the position saved at the
    /// close, as long as its hidden window (`live`) is still there or at that position's clamp,
    /// where a close before the move back landed left it. The clamp is predicted with the frame
    /// the window has now and with every frame the pin target had before the close. Anything else
    /// moved it since, and `None` leaves the caller to its live frame. Consumes the record.
    pub(crate) fn take_closed_pin(
        &mut self,
        label: &str,
        live: Option<(i32, i32)>,
        layout: &Layout<'_>,
    ) -> Option<ClosedPin> {
        let closed = self.closed.remove(label)?;
        let still_at_pin = live.is_none_or(|live| {
            near(live, closed.position)
                || std::iter::once(layout.size)
                    .chain(closed.sizes.iter().copied())
                    .any(|size| is_clamp_of(closed.position, size, live, layout.work_areas))
        });
        still_at_pin.then_some(closed)
    }

    /// Whether `label` was closed while pinned and has not been shown again since.
    pub(crate) fn was_closed_while_pinned(&self, label: &str) -> bool {
        self.closed.contains_key(label)
    }

    /// The live pin target of `label`, if it has one.
    pub(crate) fn target(&mut self, label: &str, now: Instant) -> Option<(i32, i32)> {
        self.prune(now);
        self.pins.get(label).map(|pin| pin.position)
    }

    /// The position to save or remember for `label` instead of its `live` frame: while a pin is
    /// live, the live frame may be the window manager's clamp, so the pin target is the user's.
    /// A live frame that is neither the target, its clamp nor a superseded target is a real move
    /// whose Moved event has yet to run (judged against `layout` when the caller has one): it wins.
    pub(crate) fn position_to_keep(
        &mut self,
        label: &str,
        live: Option<(i32, i32)>,
        layout: Option<&Layout<'_>>,
        now: Instant,
    ) -> Option<(i32, i32)> {
        self.prune(now);
        let Some(pin) = self.pins.get(label) else {
            return live;
        };
        match (live, layout) {
            (Some(live), Some(layout)) if pin.spot(live, layout) == Spot::Elsewhere => Some(live),
            _ => Some(pin.position),
        }
    }

    /// A pinned palette was just shown again and its `live` frame already sits at the pin's clamp.
    /// The window manager may report no move for it (the frame was clamped before and the move back
    /// was lost when it was hidden), so the move back is due now: returns the target to move it to,
    /// and counts it as one of the pin's moves back. `None` when no move back is due, including
    /// when one was already sent for this very position and has yet to land.
    pub(crate) fn correction_due(
        &mut self,
        label: &str,
        live: (i32, i32),
        layout: &Layout<'_>,
        now: Instant,
    ) -> Option<(i32, i32)> {
        self.prune(now);
        let pin = self.pins.get_mut(label)?;
        if pin.answered.is_some_and(|answered| near(answered, live))
            || pin.spot(live, layout) != Spot::Clamp
            || pin.corrections >= MAX_CORRECTIONS
            || !(layout.title_reachable)(pin.position)
        {
            return None;
        }
        pin.corrections += 1;
        pin.answered = Some(live);
        Some(pin.position)
    }

    /// One look at `label` while it is mapped (see [`after_map_step`]): `live` is its frame now,
    /// and `looks` what the same run of looks saw before. The first look at a pin starts its clock
    /// again, so the pin lasts [`PIN_DURATION`] from the map rather than from the show request.
    /// Returns whether to judge the frame now ([`Self::correction_due`]): at the run's first look,
    /// which catches a palette mapped at its old clamp with no Moved event, and after that only
    /// once the frame has stayed at a new position since the previous look, so that a Moved event
    /// reporting that position is handled first. Never at the target, and once per position.
    pub(crate) fn mapped_look(
        &mut self,
        label: &str,
        live: (i32, i32),
        looks: &mut AfterMapLooks,
        now: Instant,
    ) -> bool {
        self.prune(now);
        let first = !std::mem::replace(&mut looks.mapped, true);
        let previous = looks.previous.replace(live);
        if previous != Some(live) {
            looks.judged = None;
        }
        let Some(pin) = self.pins.get_mut(label) else {
            return false;
        };
        if !pin.mapped {
            pin.mapped = true;
            pin.until = pin.until.max(now + PIN_DURATION);
        }
        let due =
            live != pin.position && looks.judged != Some(live) && (first || previous == Some(live));
        if due {
            looks.judged = Some(live);
        }
        due
    }

    /// The target of `label`'s pin and how long ago it expired, when it expired by itself within
    /// the last [`EXPIRED_PIN_MEMORY`] and no newer pin, close or drag has replaced it. Only for
    /// the diagnostic: a Moved event this late is handled as usual.
    pub(crate) fn expired_pin(
        &mut self,
        label: &str,
        now: Instant,
    ) -> Option<((i32, i32), Duration)> {
        self.prune(now);
        self.expired
            .get(label)
            .map(|record| (record.position, now.saturating_duration_since(record.at)))
    }

    pub(crate) fn moved(
        &mut self,
        label: &str,
        position: (i32, i32),
        layout: &Layout<'_>,
        now: Instant,
    ) -> MovedDecision {
        self.prune(now);
        let Some(pin) = self.pins.get_mut(label) else {
            return MovedDecision::Unpinned;
        };
        let target = pin.position;
        match pin.spot(position, layout) {
            Spot::Target => {
                pin.record_size(layout.size);
                // Before any move back, the window manager's placement may still be on its way
                // (GTK reports the requested position first). Once a move back has landed, it is
                // done.
                if pin.corrections > 0 {
                    self.pins.remove(label);
                }
                MovedDecision::AtPin
            }
            Spot::Superseded => MovedDecision::Superseded,
            Spot::Elsewhere => {
                self.pins.remove(label);
                MovedDecision::Moved
            }
            Spot::Clamp => {
                pin.record_size(layout.size);
                if !(layout.title_reachable)(target) {
                    self.pins.remove(label);
                    return MovedDecision::Unreachable(target);
                }
                // A look after the map leaves this position to the move back decided here.
                pin.answered = Some(position);
                if pin.corrections >= MAX_CORRECTIONS {
                    return MovedDecision::Hold(target);
                }
                pin.corrections += 1;
                MovedDecision::Reassert(target)
            }
        }
    }
}

/// What one look at a palette just shown again does (see [`AFTER_MAP_INTERVAL`]). The show is
/// queued on the GTK main loop, so the frame is judged once the palette is mapped, not as the show
/// is requested: judged before the map, a palette that then maps at its pin's clamp with no Moved
/// event would stay there. GTK reports the requested position first, and the window manager's
/// placement may come much later, so the looks go on for as long as the pin lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AfterMapStep {
    /// Mapped: judge the frame now ([`MapPins::mapped_look`]), and look again after
    /// [`AFTER_MAP_INTERVAL`] while the pin lives.
    Check,
    /// Not mapped yet: look again after [`AFTER_MAP_INTERVAL`].
    Wait,
    /// No pin left to hold, the palette was hidden again after a look saw it mapped, or the map
    /// did not come within [`AFTER_MAP_WAIT`]: stop looking.
    Stop,
}

/// What one run of looks at a palette just shown again remembers from look to look.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct AfterMapLooks {
    /// Whether a look of this run has seen the palette mapped.
    mapped: bool,
    /// The frame the previous look saw.
    previous: Option<Pixels>,
    /// The frame last judged, until the frame moves.
    judged: Option<Pixels>,
}

impl AfterMapLooks {
    /// Whether a look of this run has seen the palette mapped.
    pub(crate) fn seen_mapped(&self) -> bool {
        self.mapped
    }
}

/// The decision behind each look: `pinned` is whether the palette still has a live pin, `mapped`
/// whether it is mapped (and visible), `seen_mapped` whether an earlier look of the same run saw
/// it mapped, and `elapsed` the time since the show.
pub(crate) fn after_map_step(
    pinned: bool,
    mapped: bool,
    seen_mapped: bool,
    elapsed: Duration,
) -> AfterMapStep {
    if !pinned {
        AfterMapStep::Stop
    } else if mapped {
        AfterMapStep::Check
    } else if seen_mapped || elapsed >= AFTER_MAP_WAIT {
        AfterMapStep::Stop
    } else {
        AfterMapStep::Wait
    }
}

/// The outer frame a window will have once its inner size is `inner`: its decorations (the
/// difference between `outer` and `current_inner`, the frame it has now) stay as they are.
pub(crate) fn outer_size_for_inner(
    outer: (u32, u32),
    current_inner: (u32, u32),
    inner: (u32, u32),
) -> (i32, i32) {
    let axis = |outer: u32, current: u32, inner: u32| {
        let value = i64::from(inner) + i64::from(outer) - i64::from(current);
        i32::try_from(value.max(0)).unwrap_or(i32::MAX)
    };
    (
        axis(outer.0, current_inner.0, inner.0),
        axis(outer.1, current_inner.1, inner.1),
    )
}

static PINS: LazyLock<Mutex<MapPins>> = LazyLock::new(Default::default);

pub(crate) fn with_pins<T>(task: impl FnOnce(&mut MapPins) -> T) -> T {
    task(&mut PINS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN: &str = "toolset-core-main";
    /// The Linux VM: one 1680 x 1050 screen with a 44-px panel at the bottom.
    const SCREEN: [WorkArea; 1] = [WorkArea {
        x: 0,
        y: 0,
        width: 1680,
        height: 1006,
    }];
    /// Main's outer frame: 1311 x 80.
    const MAIN_SIZE: (i32, i32) = (1311, 80);

    fn reachable(_: (i32, i32)) -> bool {
        true
    }

    fn unreachable(_: (i32, i32)) -> bool {
        false
    }

    fn vm() -> Layout<'static> {
        Layout {
            size: MAIN_SIZE,
            work_areas: &SCREEN,
            title_reachable: &reachable,
        }
    }

    /// Two monitors side by side: the VM's screen, and a 1920 x 1080 one to its right.
    const TWO: [WorkArea; 2] = [
        SCREEN[0],
        WorkArea {
            x: 1680,
            y: 0,
            width: 1920,
            height: 1080,
        },
    ];

    #[test]
    fn the_predicted_clamp_moves_only_the_axis_that_overhung() {
        // 450 + 1311 overhangs the right edge by 81 px; y stays.
        assert_eq!(
            predicted_clamp((450, 315), MAIN_SIZE, &SCREEN),
            Some((369, 315))
        );
        // Off the left edge, and below the panel.
        assert_eq!(
            predicted_clamp((-40, 990), MAIN_SIZE, &SCREEN),
            Some((0, 926))
        );
        // A frame wider than the work area starts at its left edge.
        assert_eq!(
            predicted_clamp((200, 10), (2000, 80), &SCREEN),
            Some((0, 10))
        );
        // Inside: no clamp moves it.
        assert_eq!(predicted_clamp((100, 100), MAIN_SIZE, &TWO), None);
        // Touching no work area at all: nothing to clamp into.
        assert_eq!(predicted_clamp((5000, 100), MAIN_SIZE, &TWO), None);
        // Straddling two monitors: only the one it overlaps most (680 px of the left one against
        // 631 of the right) is where the window manager keeps it.
        assert_eq!(
            predicted_clamp((1000, 100), MAIN_SIZE, &TWO),
            Some((369, 100))
        );
        assert_eq!(
            predicted_clamp((1400, 100), MAIN_SIZE, &TWO),
            Some((1680, 100))
        );
    }

    #[test]
    fn a_window_manager_clamp_after_a_dialog_is_moved_back_and_never_saved() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), None, now);
        // GTK reports the requested position as it maps the window.
        assert_eq!(
            pins.moved(MAIN, (450, 315), &vm(), now),
            MovedDecision::AtPin
        );
        // KWin keeps the whole 1311-px frame on the 1680-px screen; within 2 px still counts.
        assert_eq!(
            pins.moved(MAIN, (371, 314), &vm(), now + Duration::from_millis(20)),
            MovedDecision::Reassert((450, 315))
        );
        // The move back lands; the pin is done.
        assert_eq!(
            pins.moved(MAIN, (450, 315), &vm(), now + Duration::from_millis(40)),
            MovedDecision::AtPin
        );
        assert_eq!(pins.target(MAIN, now), None);
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), now + Duration::from_millis(60)),
            MovedDecision::Unpinned
        );
    }

    #[test]
    fn a_window_manager_move_by_the_user_ends_the_pin_and_is_saved() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), None, now);
        // Alt-drag right after the dialog: same x as the clamp, another y.
        assert_eq!(
            pins.moved(MAIN, (369, 500), &vm(), now + Duration::from_millis(300)),
            MovedDecision::Moved
        );
        assert_eq!(pins.target(MAIN, now), None);
        // Window Operations ▸ Move a little further than the rounding slack.
        pins.pin(MAIN, (450, 315), None, now);
        assert_eq!(
            pins.moved(MAIN, (366, 315), &vm(), now),
            MovedDecision::Moved
        );
        // A palette fully inside the work area has no clamp at all: any move is the user's.
        pins.pin(MAIN, (100, 100), None, now);
        assert_eq!(
            pins.moved(MAIN, (100, 400), &vm(), now),
            MovedDecision::Moved
        );
    }

    #[test]
    fn a_window_manager_that_refuses_the_move_back_keeps_the_saved_position() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), None, now);
        for _ in 0..MAX_CORRECTIONS {
            assert_eq!(
                pins.moved(MAIN, (369, 315), &vm(), now),
                MovedDecision::Reassert((450, 315))
            );
        }
        // No endless fight: the position is neither saved nor moved again until the pin expires.
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), now),
            MovedDecision::Hold((450, 315))
        );
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), now + PIN_DURATION),
            MovedDecision::Unpinned
        );
        assert_eq!(pins.target(MAIN, now), None);
    }

    #[test]
    fn a_pin_whose_title_became_unreachable_is_dropped_instead_of_corrected() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), None, now);
        let layout = Layout {
            title_reachable: &unreachable,
            ..vm()
        };
        assert_eq!(
            pins.moved(MAIN, (369, 315), &layout, now),
            MovedDecision::Unreachable((450, 315))
        );
        assert_eq!(pins.target(MAIN, now), None);
    }

    #[test]
    fn a_pin_that_no_window_manager_disturbs_expires_by_itself() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), None, now);
        assert_eq!(
            pins.moved(MAIN, (451, 314), &vm(), now),
            MovedDecision::AtPin
        );
        assert_eq!(pins.target(MAIN, now), Some((450, 315)));
        // A later move is the user's.
        let later = now + PIN_DURATION + Duration::from_millis(1);
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), later),
            MovedDecision::Unpinned
        );
        assert_eq!(pins.target(MAIN, later), None);
    }

    #[test]
    fn expired_pins_are_pruned_on_every_decision() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin("toolset-core-rings", (10, 10), None, now);
        let later = now + PIN_DURATION;
        // A decision about another palette drops the expired pin too.
        assert_eq!(
            pins.moved(MAIN, (1, 1), &vm(), later),
            MovedDecision::Unpinned
        );
        assert!(pins.pins.is_empty());
        pins.pin("toolset-core-rings", (10, 10), None, now);
        pins.pin(MAIN, (450, 315), None, later);
        assert_eq!(pins.pins.len(), 1);
        pins.pin("toolset-core-rings", (10, 10), None, now);
        pins.moved_by_chemdraft(MAIN, (0, 315), None, later);
        assert_eq!(pins.pins.len(), 1);
        pins.pin("toolset-core-rings", (10, 10), None, now);
        assert_eq!(pins.target(MAIN, later), Some((0, 315)));
        assert_eq!(pins.pins.len(), 1);
    }

    #[test]
    fn closing_or_hiding_a_pinned_palette_keeps_the_pin_not_the_clamp() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        // Unpinned: the live frame.
        assert_eq!(
            pins.position_to_keep(MAIN, Some((369, 315)), Some(&vm()), now),
            Some((369, 315))
        );
        assert_eq!(pins.position_to_keep(MAIN, None, Some(&vm()), now), None);
        // Closed (or hidden by a second dialog) before the move back landed.
        pins.pin(MAIN, (450, 315), None, now);
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), now),
            MovedDecision::Reassert((450, 315))
        );
        assert_eq!(
            pins.position_to_keep(MAIN, Some((369, 315)), Some(&vm()), now),
            Some((450, 315))
        );
        assert_eq!(
            pins.position_to_keep(MAIN, None, Some(&vm()), now),
            Some((450, 315))
        );
        // Once the pin has expired, the live frame again.
        assert_eq!(
            pins.position_to_keep(MAIN, Some((369, 315)), Some(&vm()), now + PIN_DURATION),
            Some((369, 315))
        );
    }

    #[test]
    fn chemdraft_moves_retarget_the_pin_and_a_drag_ends_it() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        // Unpinned palettes are untouched by ChemDraft's own moves.
        pins.moved_by_chemdraft(MAIN, (0, 315), None, now);
        assert_eq!(pins.target(MAIN, now), None);
        assert_eq!(
            pins.moved(MAIN, (0, 315), &vm(), now),
            MovedDecision::Unpinned
        );

        pins.pin(MAIN, (450, 315), None, now);
        pins.moved_by_chemdraft(MAIN, (300, 315), None, now);
        assert_eq!(
            pins.moved(MAIN, (300, 315), &vm(), now),
            MovedDecision::AtPin
        );
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), now),
            MovedDecision::Superseded
        );
        pins.forget(MAIN);
        assert_eq!(
            pins.moved(MAIN, (700, 20), &vm(), now),
            MovedDecision::Unpinned
        );
        // Other palettes keep their own pins.
        pins.pin("toolset-core-rings", (10, 10), None, now);
        pins.forget(MAIN);
        assert_eq!(pins.target("toolset-core-rings", now), Some((10, 10)));
    }

    #[test]
    fn a_drag_after_a_restore_is_never_undone_by_the_move_back() {
        let restored = Instant::now();
        let look = restored + AFTER_MAP_INTERVAL;
        let mut pins = MapPins::default();
        // The page-size prompt ends: Main is pinned at its pre-hide position and shown again.
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), restored);
        // The user grabs Main before the look 50 ms later: the look must not move it back.
        pins.drag_started(MAIN, restored + Duration::from_millis(20));
        assert!(!pins.move_back_after_restore(MAIN, (450, 315), restored, look));
        assert_eq!(pins.target(MAIN, look), None);
        // A later restore is not blocked by that earlier drag.
        let again = look + Duration::from_secs(1);
        pins.pin(MAIN, (600, 315), Some(MAIN_SIZE), again);
        let again_look = again + AFTER_MAP_INTERVAL;
        assert!(pins.move_back_after_restore(MAIN, (600, 315), again, again_look));
        // Without a drag the window manager's placement is undone, whether or not its Moved event
        // already ended the pin, and a live pin is re-targeted so the move back is held there.
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), restored);
        pins.moved_by_chemdraft(MAIN, (300, 315), None, restored);
        assert!(pins.move_back_after_restore(MAIN, (450, 315), restored, look));
        assert_eq!(pins.target(MAIN, look), Some((450, 315)));
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), restored);
        assert_eq!(
            pins.moved(MAIN, (184, 463), &vm(), look),
            MovedDecision::Moved
        );
        assert!(pins.move_back_after_restore(MAIN, (450, 315), restored, look));
        // Other palettes' drags do not count.
        pins.drag_started("toolset-core-rings", look);
        assert!(pins.move_back_after_restore(MAIN, (450, 315), restored, look));
    }

    #[test]
    fn a_correction_to_a_superseded_target_is_neither_saved_nor_corrected() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), None, now);
        // KWin clamps; ChemDraft sends a move back to 450.
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), now),
            MovedDecision::Reassert((450, 315))
        );
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), now),
            MovedDecision::Reassert((450, 315))
        );
        // A content fit then puts the palette at 100 (a narrower frame).
        pins.moved_by_chemdraft(MAIN, (100, 315), None, now);
        let narrower = Layout {
            size: (900, 80),
            ..vm()
        };
        // The move back to 450 lands late: ignored, and the fit's own move follows.
        assert_eq!(
            pins.moved(MAIN, (450, 315), &narrower, now),
            MovedDecision::Superseded
        );
        assert_eq!(pins.target(MAIN, now), Some((100, 315)));
        assert_eq!(
            pins.moved(MAIN, (100, 315), &narrower, now),
            MovedDecision::AtPin
        );
        // The new target starts with its own moves back: the count was reset.
        pins.moved_by_chemdraft(MAIN, (1000, 315), None, now);
        for _ in 0..MAX_CORRECTIONS {
            assert_eq!(
                pins.moved(MAIN, (780, 315), &narrower, now),
                MovedDecision::Reassert((1000, 315))
            );
        }
        assert_eq!(
            pins.moved(MAIN, (780, 315), &narrower, now),
            MovedDecision::Hold((1000, 315))
        );
        // A real move elsewhere still ends the pin.
        assert_eq!(
            pins.moved(MAIN, (500, 600), &narrower, now),
            MovedDecision::Moved
        );
    }

    #[test]
    fn a_late_clamp_of_a_superseded_target_is_judged_with_the_frame_it_had() {
        let now = Instant::now();
        let narrower = Layout {
            size: (900, 80),
            ..vm()
        };
        // The 1311-px frame pinned at 450 is clamped to 369; a fit then narrows it to 900 px and
        // puts it at 700. A late Moved at the old clamp is neither saved nor the user's.
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), now),
            MovedDecision::Reassert((450, 315))
        );
        pins.moved_by_chemdraft(MAIN, (700, 315), None, now);
        assert_eq!(
            pins.moved(MAIN, (369, 315), &narrower, now),
            MovedDecision::Superseded
        );
        assert_eq!(pins.target(MAIN, now), Some((700, 315)));
        // The same when the fit came before any Moved event: the pin's own size is used.
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        pins.moved_by_chemdraft(MAIN, (700, 315), None, now);
        assert_eq!(
            pins.moved(MAIN, (369, 315), &narrower, now),
            MovedDecision::Superseded
        );
        assert_eq!(pins.target(MAIN, now), Some((700, 315)));
    }

    #[test]
    fn each_superseded_target_keeps_the_frame_it_was_moved_with() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        // A recovery moves the 1100-px frame to 700 (its clamp would be 1680 - 1100 = 580), then a
        // fit narrows it to 700 px at 900, both before any Moved event.
        pins.moved_by_chemdraft(MAIN, (700, 315), Some((1100, 80)), now);
        pins.moved_by_chemdraft(MAIN, (900, 315), Some((700, 80)), now);
        let fitted = Layout {
            size: (700, 80),
            ..vm()
        };
        // A late clamp of the 700 target is judged with its 1100-px frame: ignored, not saved.
        assert_eq!(
            pins.moved(MAIN, (580, 315), &fitted, now),
            MovedDecision::Superseded
        );
        assert_eq!(
            pins.position_to_keep(MAIN, Some((580, 315)), Some(&fitted), now),
            Some((900, 315))
        );
        // The first target's clamp still uses its own 1311-px frame.
        assert_eq!(
            pins.moved(MAIN, (369, 315), &fitted, now),
            MovedDecision::Superseded
        );
        assert_eq!(pins.target(MAIN, now), Some((900, 315)));
        // A real move elsewhere still ends the pin.
        assert_eq!(
            pins.moved(MAIN, (575, 315), &fitted, now),
            MovedDecision::Moved
        );
    }

    #[test]
    fn a_resize_in_place_gives_the_target_its_new_frame_without_moving_it() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        // Unpinned palettes are untouched.
        pins.resized_by_chemdraft(MAIN, (900, 80), now);
        assert_eq!(pins.target(MAIN, now), None);
        // The 1311-px frame pinned at 450 is fitted in place to 1250 px, then retargeted to 700.
        // On the 1680-px work area: 450 + 1311 = 1761 overhangs, clamp 1680 - 1311 = 369;
        // 450 + 1250 = 1700 still overhangs, clamp 1680 - 1250 = 430 (not within 2 px of 450 or
        // 369). The new 700-px frame at 700 ends at 1400 and fits, so it has no clamp.
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        pins.resized_by_chemdraft(MAIN, (1250, 80), now);
        assert_eq!(pins.target(MAIN, now), Some((450, 315)));
        pins.moved_by_chemdraft(MAIN, (700, 315), None, now);
        let narrower = Layout {
            size: (700, 80),
            ..vm()
        };
        // A late clamp of 450 is predicted with every frame it had: the 1250-px one (430), and
        // the 1311-px one it was mapped with (369).
        assert_eq!(
            pins.moved(MAIN, (430, 315), &narrower, now),
            MovedDecision::Superseded
        );
        assert_eq!(
            pins.moved(MAIN, (369, 315), &narrower, now),
            MovedDecision::Superseded
        );
        // Anywhere else is a real move.
        assert_eq!(
            pins.moved(MAIN, (400, 315), &narrower, now),
            MovedDecision::Moved
        );
    }

    #[test]
    fn a_clamp_of_the_mapped_frame_reported_after_a_resize_in_place_is_still_its_clamp() {
        // The 1311-px frame pinned at 450 is clamped to 1680 - 1311 = 369 as it maps, and a
        // content fit shrinks it in place to 1200 px before that clamp's Moved event is handled.
        // At 1200 px the target fits (450 + 1200 = 1650), so the current frame alone predicts no
        // clamp; the Moved event the resize produces at 369 must still not end the pin.
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        pins.resized_by_chemdraft(MAIN, (1200, 80), now);
        let fitted = Layout {
            size: (1200, 80),
            ..vm()
        };
        assert_eq!(predicted_clamp((450, 315), (1200, 80), &SCREEN), None);
        // Closing or hiding now keeps the pin, not the clamp.
        assert_eq!(
            pins.position_to_keep(MAIN, Some((369, 315)), Some(&fitted), now),
            Some((450, 315))
        );
        // A palette shown at that clamp is moved back at once, and the Moved event at the clamp
        // is the window manager's placement: moved back, never saved.
        assert_eq!(
            pins.correction_due(MAIN, (369, 315), &fitted, now),
            Some((450, 315))
        );
        assert_eq!(
            pins.moved(MAIN, (369, 315), &fitted, now + Duration::from_millis(20)),
            MovedDecision::Reassert((450, 315))
        );
        assert_eq!(pins.target(MAIN, now), Some((450, 315)));
        // The move back lands with the fitted frame; the pin is done.
        assert_eq!(
            pins.moved(MAIN, (450, 315), &fitted, now + Duration::from_millis(40)),
            MovedDecision::AtPin
        );
        assert_eq!(pins.target(MAIN, now), None);

        // A real move elsewhere during such a pin still ends it.
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        pins.resized_by_chemdraft(MAIN, (1200, 80), now);
        assert_eq!(
            pins.moved(MAIN, (300, 315), &fitted, now),
            MovedDecision::Moved
        );
    }

    #[test]
    fn a_palette_just_shown_is_judged_once_it_is_mapped() {
        let soon = AFTER_MAP_INTERVAL;
        // The show is still queued: look again.
        assert_eq!(after_map_step(true, false, false, soon), AfterMapStep::Wait);
        assert_eq!(
            after_map_step(true, false, false, Duration::ZERO),
            AfterMapStep::Wait
        );
        // Mapped: judge now, even at the last look.
        assert_eq!(after_map_step(true, true, false, soon), AfterMapStep::Check);
        assert_eq!(
            after_map_step(true, true, false, AFTER_MAP_WAIT),
            AfterMapStep::Check
        );
        // Never mapped in time, or the pin is gone (expired, dragged, closed): stop.
        assert_eq!(
            after_map_step(true, false, false, AFTER_MAP_WAIT),
            AfterMapStep::Stop
        );
        assert_eq!(after_map_step(false, true, false, soon), AfterMapStep::Stop);
        assert_eq!(
            after_map_step(false, false, false, soon),
            AfterMapStep::Stop
        );
    }

    #[test]
    fn the_looks_after_the_map_go_on_while_the_pin_lives() {
        // Seen mapped once: keep checking long after the map wait, for as long as the pin lives.
        let late = PIN_DURATION;
        assert_eq!(after_map_step(true, true, true, late), AfterMapStep::Check);
        // Hidden again (another dialog): this run stops; the next show starts its own.
        assert_eq!(
            after_map_step(true, false, true, AFTER_MAP_INTERVAL),
            AfterMapStep::Stop
        );
        // The pin ended: stop.
        assert_eq!(after_map_step(false, true, true, late), AfterMapStep::Stop);
    }

    /// The Linux VM, 1.2.3: Main at its natural width (1423 x 86) left overhanging the left edge.
    const OVERHANG: (i32, i32) = (-143, 159);
    const NATURAL_MAIN: (i32, i32) = (1423, 86);

    fn natural_main() -> Layout<'static> {
        Layout {
            size: NATURAL_MAIN,
            ..vm()
        }
    }

    #[test]
    fn a_window_manager_clamp_reported_after_a_busy_second_is_still_moved_back() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, OVERHANG, Some(NATURAL_MAIN), now);
        // KWin keeps the frame inside the work area on the left edge.
        assert_eq!(
            predicted_clamp(OVERHANG, NATURAL_MAIN, &SCREEN),
            Some((0, 159))
        );
        // The main thread was busy after the page-size question: the Moved event for the clamp is
        // handled 1.6 s after the pin, later than the 1.5-s pin lasted. It is still the map's.
        let late = now + Duration::from_millis(1600);
        assert_eq!(
            pins.moved(MAIN, (0, 159), &natural_main(), late),
            MovedDecision::Reassert(OVERHANG)
        );
        assert_eq!(
            pins.position_to_keep(MAIN, Some((0, 159)), Some(&natural_main()), late),
            Some(OVERHANG)
        );
    }

    #[test]
    fn the_pin_clock_starts_when_a_look_first_sees_the_palette_mapped() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, OVERHANG, Some(NATURAL_MAIN), now);
        // The map is seen only 3 s after the pin (a slow show); GTK still reports the target.
        let mapped = now + Duration::from_secs(3);
        let mut looks = AfterMapLooks::default();
        assert!(!pins.mapped_look(MAIN, OVERHANG, &mut looks, mapped));
        assert!(looks.seen_mapped());
        // KWin's clamp is handled after the pin's first PIN_DURATION, within the one from the map.
        let late = now + PIN_DURATION + Duration::from_secs(1);
        assert_eq!(
            pins.moved(MAIN, (0, 159), &natural_main(), late),
            MovedDecision::Reassert(OVERHANG)
        );
        // Later looks do not start the clock again: the pin still ends PIN_DURATION after the map.
        assert!(!pins.mapped_look(MAIN, OVERHANG, &mut looks, late));
        assert_eq!(pins.target(MAIN, mapped + PIN_DURATION), None);
        assert_eq!(
            pins.moved(MAIN, (0, 159), &natural_main(), mapped + PIN_DURATION),
            MovedDecision::Unpinned
        );
    }

    #[test]
    fn a_look_judges_a_new_position_only_once_it_stays_put() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, OVERHANG, Some(NATURAL_MAIN), now);
        let mut looks = AfterMapLooks::default();
        let at = |ms: u64| now + Duration::from_millis(ms);
        // First look: GTK still reports the target. Nothing to judge.
        assert!(!pins.mapped_look(MAIN, OVERHANG, &mut looks, at(50)));
        // KWin's clamp appears: its Moved event gets the first turn.
        assert!(!pins.mapped_look(MAIN, (0, 159), &mut looks, at(100)));
        // Still there at the next look: judge it, once.
        assert!(pins.mapped_look(MAIN, (0, 159), &mut looks, at(150)));
        assert!(!pins.mapped_look(MAIN, (0, 159), &mut looks, at(200)));
        // A run's first look judges at once: a palette mapped at its old clamp may get no Moved.
        let mut fresh = AfterMapLooks::default();
        assert!(pins.mapped_look(MAIN, (0, 159), &mut fresh, at(250)));
        // No pin, nothing to judge.
        let mut other = AfterMapLooks::default();
        assert!(!pins.mapped_look("toolset-core-rings", (0, 0), &mut other, at(250)));
    }

    #[test]
    fn a_look_does_not_send_a_second_move_back_for_a_clamp_already_answered() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, OVERHANG, Some(NATURAL_MAIN), now);
        // The Moved event for KWin's clamp is moved back.
        assert_eq!(
            pins.moved(MAIN, (0, 159), &natural_main(), now),
            MovedDecision::Reassert(OVERHANG)
        );
        // A look before that move back lands finds the frame still at the clamp: no second one.
        assert_eq!(
            pins.correction_due(MAIN, (0, 159), &natural_main(), now),
            None
        );
        // So KWin clamping once more still gets its own move back rather than being left there.
        assert_eq!(
            pins.moved(MAIN, (0, 159), &natural_main(), now),
            MovedDecision::Reassert(OVERHANG)
        );
        // A move back a look sent first is not repeated by the next look either.
        let mut pins = MapPins::default();
        pins.pin(MAIN, OVERHANG, Some(NATURAL_MAIN), now);
        assert_eq!(
            pins.correction_due(MAIN, (0, 159), &natural_main(), now),
            Some(OVERHANG)
        );
        assert_eq!(
            pins.correction_due(MAIN, (0, 159), &natural_main(), now),
            None
        );
        // A new target ChemDraft moves the palette to starts with nothing answered.
        pins.moved_by_chemdraft(MAIN, (-100, 159), Some(NATURAL_MAIN), now);
        assert_eq!(
            pins.correction_due(MAIN, (0, 159), &natural_main(), now),
            Some((-100, 159))
        );
    }

    #[test]
    fn a_pin_that_expired_by_itself_is_remembered_briefly_for_the_log() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, OVERHANG, Some(NATURAL_MAIN), now);
        assert_eq!(pins.expired_pin(MAIN, now), None);
        let late = now + PIN_DURATION + Duration::from_millis(250);
        assert_eq!(
            pins.moved(MAIN, (0, 159), &natural_main(), late),
            MovedDecision::Unpinned
        );
        assert_eq!(
            pins.expired_pin(MAIN, late),
            Some((OVERHANG, Duration::from_millis(250)))
        );
        // Forgotten after a while, and at once by a new pin or a drag.
        assert_eq!(
            pins.expired_pin(MAIN, now + PIN_DURATION + EXPIRED_PIN_MEMORY),
            None
        );
        pins.pin(MAIN, OVERHANG, None, late);
        assert_eq!(pins.expired_pin(MAIN, late), None);
        pins.forget(MAIN);
        assert_eq!(pins.expired_pin(MAIN, late + PIN_DURATION), None);
        // A pin a user move ended did not expire.
        pins.pin(MAIN, OVERHANG, Some(NATURAL_MAIN), now);
        assert_eq!(
            pins.moved(MAIN, (300, 400), &natural_main(), now),
            MovedDecision::Moved
        );
        assert_eq!(pins.expired_pin(MAIN, late), None);
    }

    #[test]
    fn the_outer_frame_after_a_resize_keeps_its_decorations() {
        assert_eq!(
            outer_size_for_inner((1311, 80), (1311, 80), (700, 80)),
            (700, 80)
        );
        assert_eq!(
            outer_size_for_inner((1313, 110), (1311, 80), (700, 60)),
            (702, 90)
        );
    }

    #[test]
    fn only_the_work_area_the_frame_is_placed_in_supplies_the_clamp() {
        let now = Instant::now();
        let two = Layout {
            work_areas: &TWO,
            ..vm()
        };
        let mut pins = MapPins::default();
        pins.pin(MAIN, (1000, 100), Some(MAIN_SIZE), now);
        // KWin keeps the frame in the left work area, which it overlaps most.
        assert_eq!(
            pins.moved(MAIN, (369, 100), &two, now),
            MovedDecision::Reassert((1000, 100))
        );
        // An Alt-drag onto the right monitor's edge is the user's, not another clamp.
        assert_eq!(
            pins.moved(MAIN, (1680, 100), &two, now),
            MovedDecision::Moved
        );
        assert_eq!(pins.target(MAIN, now), None);
    }

    #[test]
    fn a_real_move_still_queued_wins_over_the_pin_when_closing_or_hiding() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        // The clamp, or the target itself: the pin.
        assert_eq!(
            pins.position_to_keep(MAIN, Some((369, 315)), Some(&vm()), now),
            Some((450, 315))
        );
        assert_eq!(
            pins.position_to_keep(MAIN, Some((451, 315)), Some(&vm()), now),
            Some((450, 315))
        );
        // An Alt-drag whose Moved event has not run yet: the live frame.
        assert_eq!(
            pins.position_to_keep(MAIN, Some((200, 600)), Some(&vm()), now),
            Some((200, 600))
        );
        // Without a layout to judge it by, the pin as before.
        assert_eq!(
            pins.position_to_keep(MAIN, Some((200, 600)), None, now),
            Some((450, 315))
        );
        // A frame still at a target ChemDraft replaced: the newer target.
        pins.moved_by_chemdraft(MAIN, (300, 315), None, now);
        assert_eq!(
            pins.position_to_keep(MAIN, Some((450, 315)), Some(&vm()), now),
            Some((300, 315))
        );
        // Judging it leaves the pin to the Moved event.
        assert_eq!(pins.target(MAIN, now), Some((300, 315)));
    }

    #[test]
    fn an_exact_clamp_of_a_tiny_overhang_is_corrected_not_taken_for_the_pin() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        // 370 + 1311 overhangs the 1680-px screen by one pixel: the clamp is 369, within the
        // target's slack.
        pins.pin(MAIN, (370, 315), Some(MAIN_SIZE), now);
        assert_eq!(
            pins.moved(MAIN, (370, 315), &vm(), now),
            MovedDecision::AtPin
        );
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), now),
            MovedDecision::Reassert((370, 315))
        );
        assert_eq!(
            pins.position_to_keep(MAIN, Some((369, 315)), Some(&vm()), now),
            Some((370, 315))
        );
        // The move back lands.
        assert_eq!(
            pins.moved(MAIN, (370, 315), &vm(), now),
            MovedDecision::AtPin
        );
        assert_eq!(pins.target(MAIN, now), None);
    }

    #[test]
    fn a_palette_shown_at_its_old_clamp_is_moved_back_without_waiting_for_a_move() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        // At the target, or somewhere else: nothing is due, and the pin stays.
        assert_eq!(pins.correction_due(MAIN, (450, 315), &vm(), now), None);
        assert_eq!(pins.correction_due(MAIN, (100, 100), &vm(), now), None);
        assert_eq!(pins.target(MAIN, now), Some((450, 315)));
        // At the clamp: due now, and it counts as a move back.
        assert_eq!(
            pins.correction_due(MAIN, (369, 315), &vm(), now),
            Some((450, 315))
        );
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), now),
            MovedDecision::Reassert((450, 315))
        );
        assert_eq!(pins.correction_due(MAIN, (369, 315), &vm(), now), None);
        // A target whose title can no longer be grabbed is not restored.
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        let layout = Layout {
            title_reachable: &unreachable,
            ..vm()
        };
        assert_eq!(pins.correction_due(MAIN, (369, 315), &layout, now), None);
        // Unpinned: nothing.
        assert_eq!(
            pins.correction_due("toolset-core-rings", (0, 0), &vm(), now),
            None
        );
    }

    #[test]
    fn a_palette_closed_before_the_move_back_reopens_at_its_pin() {
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        assert_eq!(
            pins.moved(MAIN, (369, 315), &vm(), now),
            MovedDecision::Reassert((450, 315))
        );
        // Closed at the clamp: the pin is saved and the pin ends.
        let kept = pins.position_to_keep(MAIN, Some((369, 315)), Some(&vm()), now);
        assert_eq!(kept, Some((450, 315)));
        pins.close(MAIN, kept);
        assert_eq!(pins.target(MAIN, now), None);
        // The hidden window is still at the clamp: reopen from the saved position, once.
        assert_eq!(
            pins.take_closed_pin(MAIN, Some((369, 315)), &vm())
                .map(|pin| pin.position),
            Some((450, 315))
        );
        assert!(pins
            .take_closed_pin(MAIN, Some((369, 315)), &vm())
            .is_none());

        // Moved elsewhere while hidden: its live frame, not the old record.
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        pins.close(MAIN, Some((450, 315)));
        assert!(pins
            .take_closed_pin(MAIN, Some((100, 100)), &vm())
            .is_none());
        // Closed with no pin: the caller passes nothing, and nothing is recorded.
        pins.close(MAIN, None);
        assert!(pins
            .take_closed_pin(MAIN, Some((369, 315)), &vm())
            .is_none());
        // A destroyed window, or a new pin, drops the record.
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        pins.close(MAIN, Some((450, 315)));
        pins.forget(MAIN);
        assert!(pins
            .take_closed_pin(MAIN, Some((369, 315)), &vm())
            .is_none());
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        pins.close(MAIN, Some((450, 315)));
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        assert!(pins
            .take_closed_pin(MAIN, Some((369, 315)), &vm())
            .is_none());
    }

    #[test]
    fn a_palette_resized_in_place_and_closed_reopens_at_its_pin() {
        // Main's 1311-px frame pinned at 450 is clamped to 1680 - 1311 = 369 as it maps; a content
        // fit then shrinks it in place to 1200 px, which would fit at 450 (450 + 1200 = 1650).
        // Closed before the move back landed, the hidden window still sits at 369.
        let now = Instant::now();
        let mut pins = MapPins::default();
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        pins.resized_by_chemdraft(MAIN, (1200, 80), now);
        let fitted = Layout {
            size: (1200, 80),
            ..vm()
        };
        assert_eq!(predicted_clamp((450, 315), (1200, 80), &SCREEN), None);
        let kept = pins.position_to_keep(MAIN, Some((369, 315)), Some(&fitted), now);
        assert_eq!(kept, Some((450, 315)));
        pins.close(MAIN, kept);
        // Reopened with the 1200-px frame: 369 is the clamp of the 1311-px frame the target had,
        // so the saved position wins, once.
        let closed = pins
            .take_closed_pin(MAIN, Some((369, 315)), &fitted)
            .unwrap();
        pins.pin(MAIN, closed, Some(fitted.size), now);
        assert_eq!(
            pins.correction_due(MAIN, (369, 315), &fitted, now),
            Some((450, 315))
        );
        assert!(pins
            .take_closed_pin(MAIN, Some((369, 315)), &fitted)
            .is_none());

        // Anywhere else is still a move made while hidden.
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        pins.resized_by_chemdraft(MAIN, (1200, 80), now);
        pins.close(MAIN, Some((450, 315)));
        assert!(pins
            .take_closed_pin(MAIN, Some((400, 315)), &fitted)
            .is_none());

        // A record with no frame history (the saved position was not the pin's target) is judged
        // with the live frame alone.
        pins.pin(MAIN, (450, 315), Some(MAIN_SIZE), now);
        pins.resized_by_chemdraft(MAIN, (1200, 80), now);
        pins.close(MAIN, Some((300, 315)));
        assert!(pins
            .take_closed_pin(MAIN, Some((369, 315)), &fitted)
            .is_none());
    }
}
