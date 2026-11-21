use std::{collections::BTreeMap, time::Instant};

/// Collect renderer drawings under one deadline. Office is only modified if Windows commits
/// the session end. The request ID keeps late replies out of a later shutdown attempt.
pub(super) struct SessionPublish<T> {
    pub id: u32,
    deadline: Instant,
    editors: BTreeMap<String, Option<T>>,
}

impl<T> SessionPublish<T> {
    pub fn new(id: u32, deadline: Instant, editors: impl IntoIterator<Item = String>) -> Self {
        Self {
            id,
            deadline,
            editors: editors.into_iter().map(|id| (id, None)).collect(),
        }
    }

    pub fn accepting(&self, id: u32, editor: &str, now: Instant) -> bool {
        self.id == id
            && now < self.deadline
            && self.editors.get(editor).is_some_and(Option::is_none)
    }

    pub fn publish(&mut self, id: u32, editor: &str, now: Instant, content: T) -> bool {
        if !self.accepting(id, editor, now) {
            return false;
        }
        self.editors.insert(editor.to_owned(), Some(content));
        true
    }

    pub fn missing(&self) -> impl Iterator<Item = &str> {
        self.editors
            .iter()
            .filter(|(_, content)| content.is_none())
            .map(|(id, _)| id.as_str())
    }

    pub fn into_updates(self) -> Vec<(String, T)> {
        self.editors
            .into_iter()
            .filter_map(|(id, content)| Some((id, content?)))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn session_end_collects_every_editor_until_the_shared_deadline() {
        let start = Instant::now();
        let deadline = start + Duration::from_millis(1500);
        let mut pass = SessionPublish::new(4, deadline, ["17".into(), "18".into()]);
        assert!(!pass.publish(3, "17", start, "stale shutdown"));
        assert!(!pass.publish(4, "19", start, "different editor"));
        assert!(pass.publish(4, "17", start, "current drawing"));
        assert!(!pass.publish(4, "17", start, "duplicate"));
        assert!(!pass.publish(4, "18", deadline, "too late"));
        assert_eq!(pass.missing().collect::<Vec<_>>(), ["18"]);
        assert_eq!(pass.into_updates(), [("17".into(), "current drawing")]);
    }
}
