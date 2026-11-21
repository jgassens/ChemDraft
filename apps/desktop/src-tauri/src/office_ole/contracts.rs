//! OLE decisions shared by the Windows implementation and host-independent tests.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PersistState {
    Uninitialized,
    Normal,
    NoScribble(Saved),
    HandsOffSaveAs,
    HandsOffAfterSave(Saved),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Saved {
    pub generation: u64,
    pub same_storage: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PersistError {
    AlreadyInitialized,
    Unexpected,
    SaveInProgress,
    MissingStorage,
}

impl PersistState {
    pub fn initialize(self) -> Result<Self, PersistError> {
        if self == Self::Uninitialized {
            Ok(Self::Normal)
        } else {
            Err(PersistError::AlreadyInitialized)
        }
    }

    pub fn save(self, saved: Saved) -> Result<Self, PersistError> {
        match self {
            Self::Normal => Ok(Self::NoScribble(saved)),
            Self::NoScribble(_) => Err(PersistError::SaveInProgress),
            _ => Err(PersistError::Unexpected),
        }
    }

    pub fn hands_off(self) -> Result<Self, PersistError> {
        match self {
            Self::Uninitialized => Err(PersistError::Unexpected),
            Self::Normal => Ok(Self::HandsOffSaveAs),
            Self::NoScribble(saved) => Ok(Self::HandsOffAfterSave(saved)),
            hands_off => Ok(hands_off),
        }
    }

    pub fn complete(self, has_storage: bool) -> Result<Option<u64>, PersistError> {
        let saved = match self {
            Self::NoScribble(saved) => saved,
            Self::HandsOffAfterSave(saved) if has_storage => saved,
            Self::HandsOffSaveAs if has_storage => return Ok(None),
            Self::HandsOffAfterSave(_) | Self::HandsOffSaveAs => {
                return Err(PersistError::MissingStorage);
            }
            _ => return Err(PersistError::Unexpected),
        };
        Ok((saved.same_storage || has_storage).then_some(saved.generation))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CloseOption {
    SaveIfDirty,
    NoSave,
    PromptSave,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CloseDecision {
    Finish { save: bool },
    AskEditor { prompt: bool, discard: bool },
}

impl CloseOption {
    pub fn decision(self, visible: bool, dirty: bool) -> CloseDecision {
        match (self, visible) {
            (option, true) => CloseDecision::AskEditor {
                prompt: option == Self::PromptSave,
                discard: option == Self::NoSave,
            },
            (Self::NoSave, false) => CloseDecision::Finish { save: false },
            _ => CloseDecision::Finish { save: dirty },
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum CloseReadiness {
    Closed,
    Retry,
    Ready,
}

impl CloseReadiness {
    pub fn check(closed: bool, closing: bool, updating_client: bool) -> Self {
        if closed {
            Self::Closed
        } else if closing || updating_client {
            Self::Retry
        } else {
            Self::Ready
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum EditorVerb {
    Open,
    FallbackToPrimary,
    Unsupported,
}

pub(super) fn editor_verb(verb: i32) -> EditorVerb {
    match verb {
        -2..=1 => EditorVerb::Open, // OLEIVERB_OPEN, SHOW, PRIMARY/Edit, our Open
        2.. => EditorVerb::FallbackToPrimary,
        _ => EditorVerb::Unsupported,
    }
}

pub(super) fn canonical_format<T: Copy, Device>(
    mut format: T,
    target: impl FnOnce(&mut T) -> &mut *mut Device,
) -> T {
    *target(&mut format) = std::ptr::null_mut();
    format
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_transitions_and_save_copy() {
        use PersistError::*;
        use PersistState::*;
        let same = Saved {
            generation: 7,
            same_storage: true,
        };
        let copy = Saved {
            same_storage: false,
            ..same
        };
        assert_eq!(Uninitialized.initialize(), Ok(Normal));
        assert_eq!(Uninitialized.save(same), Err(Unexpected));
        assert_eq!(Uninitialized.hands_off(), Err(Unexpected));
        assert_eq!(Uninitialized.complete(true), Err(Unexpected));
        assert_eq!(Normal.complete(false), Err(Unexpected));
        assert_eq!(Normal.complete(true), Err(Unexpected));
        assert_eq!(Normal.hands_off(), Ok(HandsOffSaveAs));
        assert_eq!(HandsOffSaveAs.complete(false), Err(MissingStorage));
        assert_eq!(HandsOffSaveAs.complete(true), Ok(None));
        let pending = Normal.save(same).unwrap();
        assert_eq!(pending.save(same), Err(SaveInProgress));
        assert_eq!(pending.complete(false), Ok(Some(7)));
        assert_eq!(pending.hands_off(), Ok(HandsOffAfterSave(same)));
        let save_as = Normal.save(copy).unwrap();
        assert_eq!(save_as.complete(false), Ok(None));
        assert_eq!(save_as.complete(true), Ok(Some(7)));
        let hands_off = save_as.hands_off().unwrap();
        assert_eq!(hands_off.complete(false), Err(MissingStorage));
        assert_eq!(hands_off.complete(true), Ok(Some(7)));
        for state in [Normal, pending, HandsOffSaveAs, hands_off] {
            assert_eq!(state.initialize(), Err(AlreadyInitialized));
        }
        for state in [HandsOffSaveAs, hands_off] {
            assert_eq!(state.save(same), Err(Unexpected));
            assert_eq!(state.hands_off(), Ok(state));
        }
    }

    #[test]
    fn close_options_account_for_renderer_edits_and_native_dirtiness() {
        for dirty in [false, true] {
            assert_eq!(
                CloseOption::NoSave.decision(false, dirty),
                CloseDecision::Finish { save: false }
            );
            assert_eq!(
                CloseOption::NoSave.decision(true, dirty),
                CloseDecision::AskEditor {
                    prompt: false,
                    discard: true
                }
            );
            assert_eq!(
                CloseOption::SaveIfDirty.decision(false, dirty),
                CloseDecision::Finish { save: dirty }
            );
            assert_eq!(
                CloseOption::PromptSave.decision(false, dirty),
                CloseDecision::Finish { save: dirty }
            );
            assert_eq!(
                CloseOption::SaveIfDirty.decision(true, dirty),
                CloseDecision::AskEditor {
                    prompt: false,
                    discard: false
                }
            );
            assert_eq!(
                CloseOption::PromptSave.decision(true, dirty),
                CloseDecision::AskEditor {
                    prompt: true,
                    discard: false
                }
            );
        }
    }

    #[test]
    fn reentrant_close_must_retry_until_the_object_is_closed() {
        use CloseReadiness::*;
        assert_eq!(CloseReadiness::check(false, false, true), Retry);
        assert_eq!(CloseReadiness::check(false, true, false), Retry);
        assert_eq!(CloseReadiness::check(false, false, false), Ready);
        assert_eq!(CloseReadiness::check(true, true, false), Closed);
    }

    #[test]
    fn unsupported_verbs_follow_ole_sign_convention() {
        for verb in [-2, -1, 0, 1] {
            assert_eq!(editor_verb(verb), EditorVerb::Open);
        }
        for verb in [i32::MIN, -6, -5, -4, -3] {
            assert_eq!(editor_verb(verb), EditorVerb::Unsupported);
        }
        for verb in [2, i32::MAX] {
            assert_eq!(editor_verb(verb), EditorVerb::FallbackToPrimary);
        }
    }

    #[test]
    fn canonical_format_copies_all_fields_except_target_device() {
        let source = (14, 1, -1, 64, std::ptr::dangling_mut::<u8>());
        let canonical = canonical_format(source, |f| &mut f.4);
        assert_eq!(canonical, (14, 1, -1, 64, std::ptr::null_mut()));
        assert!(!source.4.is_null());
    }
}
